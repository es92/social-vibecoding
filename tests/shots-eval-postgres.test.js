'use strict';
const { fixtureKey } = require('./lib/media-store');
require('./lib/media-store').useMemoryMedia(require('node:test'));

// Before & after shots evals against the REAL schema in a throwaway
// PostgreSQL database (services/shots-eval.js, the shots-eval machine in
// src/workflow/shots-eval/). Pinned here, end to end:
//   - configurations are immutable versions of a recipe;
//   - an eval shoots merged proposals only, frozen from their own published
//     run, the live agent as the control and each configuration beside it;
//   - a trial runs the shots pipeline's own steps as the machine's work
//     (buildCopies, dispatchAgent, compareScreens, cleanupRun) with the
//     arm's model, prompts and budget, keeps its state and files on its own
//     rows and never touches the proposal's own shots, and its cost counts
//     against its eval's cap, charged once when its cleanup is done;
//   - two finished arms of one proposal make a blind pair, whose pick and
//     marks feed each arm's numbers;
//   - the cap stops an eval; a cancel stops
//     a trial that runs and cleans it up; the GC knows trials; an eval's
//     model calls are billed by the turn's owner.
// The builds, copies and the shots agent itself are fakes on the modules the
// pipeline reads: everything between them and the database is the
// production code. Skipped when no server is reachable, and required when
// TEST_DATABASE_URL is set, the same contract as the other *-postgres
// suites.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client, Pool } = require('pg');

const planContract = require('../src/services/visible-changes');
const controlPlane = require('../src/services/shots-control');
const shotsAgent = require('../src/services/shots-agent');
const shotsGc = require('../src/services/shots-gc');
const evals = require('../src/services/shots-eval');
const orchestrator = require('../src/services/shots-orchestrator');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const evalMachine = require('../src/workflow/shots-eval/machine.ts');
const { shotsEvalServices } = require('../src/workflow/shots-eval/services.ts');
const fixtures = require('./fixtures/shots');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const BASE = 'c'.repeat(40);
const HEAD = 'd'.repeat(40);
const MERGED = 900310;
const OPEN = 900311;
const NO_RUN = 900312;
const NO_CHANGE = 900313;
const MERGED_TWO = 900314;
const PUBLISHED_RUN = 'e'.repeat(32);
const CONFIG = { shots: { execute: true, maxRunMs: 60_000, maxAgentMs: 30_000, agentModel: 'claude-sonnet-5-5' } };

async function freshDb(t) {
  const root = new Client({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await root.connect(); }
  catch (err) {
    await root.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`Local test database unavailable: ${err.code}`);
    return null;
  }
  const database = `shots_eval_${crypto.randomBytes(6).toString('hex')}`;
  await root.query(`CREATE DATABASE ${database}`);
  const url = new URL(DSN); url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.toString(), max: 8 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {});
    await root.end().catch(() => {});
  });
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);
  return pool;
}

function intentOf(ids) {
  return planContract.parseIntent(fixtures.intent({
    stories: ids.map((id) => ({ ...fixtures.intent().stories[0], id, claim: `The board shows ${id}.` })),
  }));
}

async function seed(pool) {
  await pool.query(`INSERT INTO users (username, password) VALUES ('eval-admin', 'x'), ('eval-author', 'x')`);
  await pool.query(
    `INSERT INTO apps (id, name, slug, status, view_visibility, created_by, repo_url)
     SELECT 900301, 'Eval demo', 'eval-demo', 'running', 'public', u.id, 'https://github.com/acme/eval-demo'
       FROM users u WHERE u.username = 'eval-author'`
  );
  const session = async (id, status) => pool.query(
    `INSERT INTO chat_sessions (id, app_id, user_id, branch_name, pr_number, pr_title, status, reviewed_head_sha)
     SELECT $1::int, 900301, u.id, 'eval/demo', $1::int - 900000, 'Eval demo change', $2::varchar, $3::varchar
       FROM users u WHERE u.username = 'eval-author'`,
    [id, status, HEAD]
  );
  const publish = async (id, runId, intent, { files = false } = {}) => {
    await pool.query(
      `INSERT INTO shot_runs (id, session_id, base_sha, head_sha, plan_hash, intent, hard_verdict, state, trigger, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'verified', 'test', NOW(), NOW())`,
      [runId, id, BASE, HEAD, 'f'.repeat(64), JSON.stringify(intent),
        JSON.stringify({ passed: true, mode: 'shots', runs: 1, stories: intent.stories.map((s) => ({ id: s.id, status: 'ready', files: 2 })) })]
    );
    await pool.query(
      `UPDATE chat_sessions SET shots_run_id = $2, shots_state = 'verified', shots_detail = '{}'::jsonb WHERE id = $1`,
      [id, runId]
    );
    if (!files) return;
    for (const [side, shade] of [['base', 30], ['head', 220]]) {
      const data = fixtures.png({ shade });
      await pool.query(
        `INSERT INTO shot_artifacts (id, run_id, story_id, viewport, side, variant, media, content_type, object_key, width, height, bytes, sha256)
         VALUES ($1, $2, 'board-sort', 'desktop', $3, 'context', 'png', 'image/png', $4, 4, 3, $5, $6)`,
        [crypto.randomBytes(16).toString('hex'), runId, side, await fixtureKey(pool, data), data.length, crypto.createHash('sha256').update(data).digest('hex')]
      );
    }
  };
  await session(MERGED, 'merged');
  await publish(MERGED, PUBLISHED_RUN, intentOf(['board-sort']), { files: true });
  await session(MERGED_TWO, 'merged');
  await publish(MERGED_TWO, 'a'.repeat(32), intentOf(['board-sort', 'board-filter']));
  await session(OPEN, 'active');
  await publish(OPEN, 'b'.repeat(32), intentOf(['board-sort']));
  await session(NO_RUN, 'merged');
  await session(NO_CHANGE, 'merged');
  await pool.query(
    `INSERT INTO shot_runs (id, session_id, base_sha, head_sha, intent, state, trigger, completed_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'not_required', 'test', NOW())`,
    ['9'.repeat(32), NO_CHANGE, BASE, HEAD, JSON.stringify({ version: 1, impact: 'none', rationale: 'Server only.', stories: [] })]
  );
  await pool.query(`UPDATE chat_sessions SET shots_run_id = $2 WHERE id = $1`, [NO_CHANGE, '9'.repeat(32)]);
  const { rows: [admin] } = await pool.query(`SELECT id FROM users WHERE username = 'eval-admin'`);
  return admin.id;
}

// The pipeline's outside world, faked on the modules it reads: two builds
// that are temp dirs, their copies, signed-in personas, and a shots agent
// that saves a before and an after of every declared change through the real
// control plane. Resolves how to put them back.
function fakeOutsideWorld({ dispatched, costUsd = 0.5, hold = null }) {
  const checkouts = { base: fs.mkdtempSync(path.join(os.tmpdir(), 'eval-base-')), head: fs.mkdtempSync(path.join(os.tmpdir(), 'eval-head-')) };
  const provenance = { fixtureFingerprint: 'fixture-1', baseImageDigest: 'sha256:base', headImageDigest: 'sha256:head' };
  const patches = [
    [require('../src/services/github'), {
      compareRefs: async () => ({ files: ['frontend/src/board.tsx'], filesComplete: true }),
      getProposalDiff: async () => ({ diff: 'diff --git', fileCount: 1, truncated: false }),
    }],
    [shotsAgent, {
      dispatch: async (cfg, options) => {
        dispatched.push({
          model: shotsAgent.agentModel(cfg), budgetMs: cfg.shots.maxAgentMs, timeoutMs: options.timeoutMs,
          systemPrompt: options.systemPrompt, taskPrompt: options.taskPrompt, runId: options.runId, owner: options.owner || null,
        });
        if (hold) await hold(options);
        // The agent's calls, through the trial's workspace in Postgres.
        const intent = (await controlPlane.read(options.pool, options.runId)).intent;
        for (const story of intent.stories) {
          for (const viewport of story.viewports) {
            for (const [side, shade] of [['before', 10], ['after', 200]]) {
              await controlPlane.withControl(options.pool, { runId: options.runId, sessionId: options.session.id },
                (control) => control.saveShot({ change: story.id, screen: viewport.name, side, kind: 'screen' }, fixtures.png({ shade })));
            }
          }
        }
        return { backend: 'claude_code', model: shotsAgent.agentModel(cfg), result: { costUsd } };
      },
    }],
    [require('../src/services/shots-environment'), {
      preparePair: async (_config, { run }) => ({
        runId: run.id, fixtureFingerprint: provenance.fixtureFingerprint,
        sides: { base: { imageDigest: provenance.baseImageDigest, checkout: checkouts.base },
          head: { imageDigest: provenance.headImageDigest, checkout: checkouts.head } },
      }),
      resetPair: async () => ({ origins: { base: 'http://base.internal:3000', head: 'http://head.internal:3000' }, baseSha: BASE, headSha: HEAD, ...provenance }),
    }],
    // The copies are fakes: nothing to remove.
    [require('../src/services/shots-gc'), { cleanupRunResources: async (_c, run) => { removed.push(run.id); return []; } }],
    [require('../src/services/shots-identities'), {
      mintShotsAuthTokens: async () => ({ member: 'm', read_only_admin: 'a', full_admin: 'f' }),
      shotsGuestIdentity: async () => ({ kind: 'private', token: null }),
    }],
    [require('../src/services/shots-starter'), { beforeIsStarter: async () => false }],
    [require('../src/services/worker'), {
      isInFlight: () => false, getActiveTurnMode: () => null, stopTurn: async () => {}, stopTurnByJournal: async () => { stoppedTurns.push(1); },
      clearPendingStop: () => {}, destroyCcVolume: async (id) => { destroyed.push(id); }, finishTurn: async () => true,
    }],
    [require('../src/services/shots-diff-worker'), { screensFor: async () => [], unchangedStories: () => new Set() }],
  ];
  const removed = [];
  const destroyed = [];
  const stoppedTurns = [];
  const saved = patches.map(([mod, fakes]) => [mod, Object.fromEntries(Object.keys(fakes).map((k) => [k, mod[k]]))]);
  for (const [mod, fakes] of patches) Object.assign(mod, fakes);
  return { removed, destroyed, stoppedTurns, restore: () => { for (const [mod, real] of saved) Object.assign(mod, real); } };
}

test('shots evals, end to end (PostgreSQL)', { timeout: 180_000 }, async (t) => {
  const pool = await freshDb(t);
  if (!pool) return;
  const adminId = await seed(pool);
  // The eval machine, run here: its trials' phases are its own work.
  const rt = createRuntime({
    pool, pollMs: 50, machines: [evalMachine.shotsEval({ concurrency: 2, defaultAgentMs: CONFIG.shots.maxAgentMs })],
    services: shotsEvalServices({ config: CONFIG, pool }),
  });
  t.after(() => rt.stop());
  let rk = 0;
  const settle = async () => { for (let i = 0; i < 60; i += 1) { await rt.drain(); if (!(await rt.runServices())) { await rt.drain(); return; } } };
  const lookNow = async () => {
    await rt.append(evalMachine.MACHINE, evalMachine.KEY, { type: 'Look', payload: {} }, { requestKey: `look-${++rk}`, source: { kind: 'system', name: 'test' } });
  };
  // An admin's cancel, as appendAndWait answers it (stepped by hand here).
  const platformHere = {
    evalCancel: async (evalId) => {
      const id = await rt.append(evalMachine.MACHINE, evalMachine.KEY, { type: 'EvalCancelled', payload: { evalId } },
        { requestKey: `cancel-${++rk}`, source: { kind: 'admin', name: 'test' } });
      await rt.drain();
      const { rows: [e] } = await pool.query('SELECT result, reason FROM wf_events WHERE id = $1', [id]);
      return { status: e.result, reason: e.reason };
    },
  };
  // An older build's runner's write (a rollout): only the machine may claim.
  const asTransition = require('./lib/as-transition').asTransition;
  let configId;
  let evalId;

  await t.test('a configuration is saved as versions of a key, and lists its prompts only when asked', async () => {
    const first = await evals.saveConfig(pool, { label: 'Toast first', recipe: { guidance: 'Close any toast before you shoot.', agentMinutes: 6 }, actorId: adminId });
    assert.equal(first.ok, true);
    assert.equal(first.config.key, 'toast-first');
    assert.equal(first.config.version, 1);
    const second = await evals.saveConfig(pool, { key: 'toast-first', recipe: { guidance: 'Close any toast, then wait a second.', model: 'claude-opus-5-5' } });
    assert.equal(second.config.version, 2);
    assert.equal(second.config.label, 'Toast first', 'a version keeps its key\'s label');
    configId = second.config.id;
    assert.equal((await evals.saveConfig(pool, { label: 'x', recipe: {} })).status, 400);
    const listed = await evals.listConfigs(pool, CONFIG);
    assert.deepEqual(listed.configs.map((c) => c.version), [2, 1]);
    assert.equal(typeof listed.configs[0].recipe.guidance, 'object', 'a prompt is a hash and length');
    assert.equal(listed.live.model, 'claude-sonnet-5-5');
    const withText = await evals.listConfigs(pool, CONFIG, { prompts: true });
    assert.equal(withText.configs[0].recipe.guidance, 'Close any toast, then wait a second.');
    assert.equal(withText.live.systemPrompt, shotsAgent.SYSTEM_PROMPT);
  });

  await t.test('an eval shoots merged proposals only, frozen from their own published run', async () => {
    const refused = await evals.launch(pool, CONFIG, { sessionIds: [MERGED, OPEN, NO_RUN, NO_CHANGE], configIds: [configId], capUsd: 20 });
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.refused.map((r) => r.sessionId), [OPEN, NO_RUN, NO_CHANGE]);
    assert.match(refused.error, /Nothing was launched/);
    assert.equal((await evals.launch(pool, CONFIG, { sessionIds: [MERGED], configIds: [99999], capUsd: 20 })).status, 404);
    assert.equal((await evals.launch(pool, CONFIG, { sessionIds: [MERGED], capUsd: 1 })).status, 400, 'a cap under one trial\'s estimate');
    const { rows: [{ n: before }] } = await pool.query('SELECT COUNT(*)::int AS n FROM shots_eval_runs');
    assert.equal(before, 0, 'a refused launch writes nothing');

    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED], configIds: [configId], capUsd: 20, label: 'Toast', actorId: adminId });
    assert.equal(launched.ok, true);
    evalId = launched.eval.id;
    assert.equal(launched.eval.trials, 2);
    assert.deepEqual(launched.eval.arms.map((a) => a.arm), ['control', `config-${configId}`]);
    assert.equal(launched.eval.perTrialUsd, evals.DEFAULT_TRIAL_CENTS / 100);
    const { rows } = await pool.query('SELECT config_id, position, base_sha, head_sha, intent, state FROM shots_eval_trials WHERE eval_run_id = $1 ORDER BY position', [evalId]);
    assert.deepEqual(rows.map((r) => [r.config_id, r.position, r.state]), [[null, 1, 'planned'], [configId, 2, 'planned']]);
    assert.equal(rows[0].base_sha, BASE);
    assert.equal(rows[0].intent.stories[0].id, 'board-sort');
  });

  const dispatched = [];
  let world = fakeOutsideWorld({ dispatched });
  t.after(() => world.restore());

  await t.test('a trial runs the real pipeline with its arm, on its own rows, and is billed to its eval', async () => {
    const { rows: [sessionBefore] } = await pool.query('SELECT shots_run_id, shots_state, shots_detail FROM chat_sessions WHERE id = $1', [MERGED]);
    await lookNow();
    await rt.drain();
    const { rows: claimed } = await pool.query("SELECT id FROM shots_eval_trials WHERE eval_run_id = $1 AND state <> 'planned'", [evalId]);
    assert.equal(claimed.length, 1, 'one trial at a time on one proposal');
    await settle();

    assert.equal(dispatched.length, 2);
    const [control, tried] = dispatched;
    assert.equal(control.model, 'claude-sonnet-5-5');
    assert.equal(control.systemPrompt, shotsAgent.SYSTEM_PROMPT, 'the control is the live agent');
    assert.equal(tried.model, 'claude-opus-5-5', 'the arm\'s model');
    assert.equal(tried.systemPrompt, `${shotsAgent.SYSTEM_PROMPT}\n\nClose any toast, then wait a second.`);
    assert.equal(tried.budgetMs, CONFIG.shots.maxAgentMs, 'a version names its whole recipe: v1\'s agentMinutes is not inherited');
    assert.equal(tried.owner.machine, 'shots-eval', 'its turn the eval machine\'s work: the proxy bills it to the trial');
    assert.equal(world.removed.length, 2, 'each trial\'s copies removed');

    const { rows } = await pool.query(
      `SELECT t.id, t.state, t.config_id, t.recipe, t.hard_verdict, t.cost_cents::float8 AS cost, t.attempts,
              (SELECT COUNT(*)::int FROM shots_eval_artifacts a WHERE a.trial_id = t.id) AS files
         FROM shots_eval_trials t WHERE t.eval_run_id = $1 ORDER BY t.position`,
      [evalId]
    );
    assert.deepEqual(rows.map((r) => r.state), ['verified', 'verified']);
    assert.deepEqual(rows.map((r) => r.files), [2, 2]);
    assert.deepEqual(rows.map((r) => r.cost), [50, 50], 'what Claude Code reported, in cents');
    assert.deepEqual(rows.map((r) => r.attempts), [1, 1]);
    assert.equal(rows[0].recipe.live, true);
    assert.equal(rows[1].recipe.model, 'claude-opus-5-5');
    assert.equal(rows[1].hard_verdict.stories[0].status, 'ready');
    const { rows: [run] } = await pool.query('SELECT spent_cents::float8 AS spent, status FROM shots_eval_runs WHERE id = $1', [evalId]);
    assert.equal(run.spent, 100);

    const { rows: [sessionAfter] } = await pool.query('SELECT shots_run_id, shots_state, shots_detail FROM chat_sessions WHERE id = $1', [MERGED]);
    assert.deepEqual(sessionAfter, sessionBefore, 'the proposal\'s own shots are untouched');
    const { rows: [{ n: runs }] } = await pool.query('SELECT COUNT(*)::int AS n FROM shot_runs WHERE session_id = $1', [MERGED]);
    assert.equal(runs, 1, 'no shots run was made for the proposal');

    const { rows: [done] } = await pool.query('SELECT status FROM shots_eval_runs WHERE id = $1', [evalId]);
    assert.equal(done.status, 'done', 'an eval with nothing left is done');
  });

  await t.test('two finished arms make a blind pair, and its pick and marks feed the numbers', async () => {
    const waiting = await evals.nextPair(pool, { runId: evalId });
    assert.equal(waiting.waiting, 1);
    const { pair } = waiting;
    assert.match(pair.pairId, /^[A-Za-z0-9_-]{8,64}$/);
    assert.equal(pair.left.images.length, 2);
    assert.equal(pair.right.images.length, 2);
    assert.deepEqual(pair.left.images.map((i) => i.caption), ['board-sort · desktop · before', 'board-sort · desktop · after']);
    const text = JSON.stringify({ ...pair, left: { ...pair.left, images: [] }, right: { ...pair.right, images: [] } });
    assert.doesNotMatch(text, /control|config|Toast|live shots agent|claude-/i, 'nothing says which arm is which');

    const { rows: [p] } = await pool.query('SELECT left_is_control FROM shots_eval_pairs WHERE token = $1', [pair.pairId]);
    const armSide = p.left_is_control ? 'right' : 'left';
    const controlSide = p.left_is_control ? 'left' : 'right';
    assert.equal((await evals.submitPick(pool, { token: pair.pairId, pick: 'left', marks: [{ side: 'up', change: 'board-sort', shows: 'yes' }] })).status, 400);
    assert.equal((await evals.submitPick(pool, { token: pair.pairId, pick: 'left', marks: [{ side: 'left', change: 'nope', shows: 'yes' }] })).status, 400);
    const picked = await evals.submitPick(pool, {
      token: pair.pairId, pick: armSide, note: 'Closed the toast.', userId: adminId,
      marks: [
        { side: armSide, change: 'board-sort', shows: 'yes' },
        { side: controlSide, change: 'board-sort', shows: 'partly', misleading: true },
      ],
    });
    assert.deepEqual(picked, { ok: true, waiting: 0 });
    assert.equal((await evals.submitPick(pool, { token: pair.pairId, pick: 'tie' })).status, 409, 'once per pair');
    assert.equal((await evals.nextPair(pool, { runId: evalId })).pair, null);

    const read = await evals.getRun(pool, evalId);
    const [control, arm] = read.arms;
    assert.equal(control.arm, 'control');
    assert.equal(control.label, 'live shots agent');
    assert.equal(arm.label, 'Toast first v2');
    assert.equal(arm.ranWith.model, 'claude-opus-5-5');
    assert.deepEqual([arm.vsControl.wins, arm.vsControl.ties, arm.vsControl.losses], [1, 0, 0]);
    assert.equal(arm.marks.yes, 1);
    assert.equal(control.marks.partly, 1);
    assert.equal(control.marks.misleading, 1);
    assert.equal(arm.readyRate.rate, 1);
    assert.equal(arm.avgCostUsd, 0.5);
    assert.deepEqual(read.pairs, { waiting: 0, picked: 1, excluded: 0 });
    assert.equal(read.trials.length, 2);
    assert.equal(read.trials[1].armLabel, 'Toast first v2');
    assert.equal(read.trials[1].changes[0].status, 'ready');

    const listed = await evals.listRuns(pool);
    assert.equal(listed.evals[0].id, evalId);
    assert.equal(listed.evals[0].finished, 2);
  });

  await t.test('one proposal\'s shots come back every arm side by side, the published ones first', async () => {
    const shots = await evals.proposalShots(pool, evalId, { sessionId: MERGED });
    assert.equal(shots.ok, true);
    assert.deepEqual(shots.images.map((i) => i.caption), [
      'board-sort · desktop · published shots · before', 'board-sort · desktop · published shots · after',
      'board-sort · desktop · live shots agent · before', 'board-sort · desktop · live shots agent · after',
      'board-sort · desktop · Toast first v2 · before', 'board-sort · desktop · Toast first v2 · after',
    ]);
    assert.deepEqual(shots.arms.map((a) => a.arm), ['control', `config-${configId}`]);
    const afterOnly = await evals.proposalShots(pool, evalId, { sessionId: MERGED, side: 'after', published: false });
    assert.equal(afterOnly.images.length, 2);
    assert.equal((await evals.proposalShots(pool, evalId, { sessionId: NO_RUN })).status, 404);
  });

  await t.test('sameProposalsAs reruns the same frozen proposals', async () => {
    const again = await evals.launch(pool, CONFIG, { sameProposalsAs: evalId, capUsd: 10, repeats: 2 });
    assert.equal(again.ok, true);
    assert.deepEqual(again.eval.proposals, [MERGED]);
    assert.equal(again.eval.trials, 2, 'the control only, twice');
    await evals.cancelRun(pool, again.eval.id, { platform: platformHere });
    assert.equal((await evals.cancelRun(pool, again.eval.id, { platform: platformHere })).status, 409);
    const { rows } = await pool.query('SELECT DISTINCT state FROM shots_eval_trials WHERE eval_run_id = $1', [again.eval.id]);
    assert.deepEqual(rows.map((r) => r.state), ['cancelled']);
  });

  await t.test('an active trial the machine does not hold is left as it is: no runner from before the machine is waited out or taken over', async () => {
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    const { rows: [trial] } = await pool.query('SELECT id, attempt_id FROM shots_eval_trials WHERE eval_run_id = $1', [launched.eval.id]);
    await asTransition(pool, `UPDATE shots_eval_trials SET state = 'exploring', attempts = 1, updated_at = NOW() - interval '10 minutes' WHERE id = $1`, [trial.id]);
    world.removed.length = 0;
    await lookNow();
    await settle();
    const { rows: [row] } = await pool.query('SELECT state, attempt_id FROM shots_eval_trials WHERE id = $1', [trial.id]);
    assert.deepEqual([row.state, row.attempt_id], ['exploring', trial.attempt_id], 'not put back');
    assert.deepEqual(world.removed, [], 'nothing of it cleaned up');
    await pool.query(`UPDATE shots_eval_trials SET state = 'cancelled' WHERE id = $1`, [trial.id]);
    await pool.query(`UPDATE shots_eval_runs SET status = 'done' WHERE id = $1`, [launched.eval.id]);
  });


  await t.test('the cap stops an eval before a trial it cannot pay for', async () => {
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], configIds: [configId], capUsd: 5 });
    await pool.query('UPDATE shots_eval_runs SET spent_cents = 300 WHERE id = $1', [launched.eval.id]);
    const before = dispatched.length;
    await lookNow();
    await settle();
    assert.equal(dispatched.length, before);
    const { rows: [run] } = await pool.query('SELECT status FROM shots_eval_runs WHERE id = $1', [launched.eval.id]);
    assert.equal(run.status, 'capped');
    const { rows } = await pool.query('SELECT DISTINCT state FROM shots_eval_trials WHERE eval_run_id = $1', [launched.eval.id]);
    assert.deepEqual(rows.map((r) => r.state), ['cancelled']);
  });

  await t.test('a cancel stops a trial its agent is running: its turn stopped, everything removed, its cost charged once', async () => {
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    world.restore();
    world = fakeOutsideWorld({ dispatched, hold: () => new Promise(() => {}) });
    await lookNow();
    await rt.drain();
    await rt.runServices(); // the copies
    await rt.drain();
    const { rows: [trial] } = await pool.query('SELECT id, attempt_id, state FROM shots_eval_trials WHERE eval_run_id = $1', [launched.eval.id]);
    assert.equal(trial.state, 'exploring');
    // Its agent's turn runs (never returns here); a call the proxy billed it.
    void rt.runServices();
    await new Promise((r) => setTimeout(r, 100));
    await require('../src/workflow/shots-eval/costs.ts').addCost(pool, { trialId: trial.id, attemptId: trial.attempt_id, proxyCents: 12 });
    const out = await evals.cancelRun(pool, launched.eval.id, { platform: platformHere });
    assert.equal(out.ok, true);
    const { rows: [w] } = await pool.query(
      `SELECT status FROM wf_work WHERE machine = 'shots-eval' AND kind = 'eval.agent' AND work_key LIKE $1`, [`agent:${trial.id}:%`]);
    assert.equal(w.status, 'settled', 'its agent\'s work cancelled');
    const { rows: [cleanup] } = await pool.query(
      `SELECT input FROM wf_work WHERE machine = 'shots-eval' AND kind = 'eval.cleanup' AND work_key LIKE $1`, [`cleanup:${trial.id}:%`]);
    assert.equal(cleanup.input.stopTurn, true, 'its turn stopped by its record');
    await settle();
    const { rows: [ended] } = await pool.query('SELECT state, cost_cents::float8 AS cost FROM shots_eval_trials WHERE id = $1', [trial.id]);
    assert.deepEqual(ended, { state: 'cancelled', cost: 12 }, 'charged once');
    const { rows: [ev] } = await pool.query('SELECT status, spent_cents::float8 AS spent FROM shots_eval_runs WHERE id = $1', [launched.eval.id]);
    assert.deepEqual(ev, { status: 'cancelled', spent: 12 });
    assert.ok(world.removed.includes(trial.attempt_id));
    world.restore();
    world = fakeOutsideWorld({ dispatched });
  });

  await t.test('a phase past its time ends the trial: its copies stopped at their next step, then cleaned up, failed with why', async () => {
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    await lookNow();
    await rt.drain();
    const { rows: [trial] } = await pool.query('SELECT id FROM shots_eval_trials WHERE eval_run_id = $1', [launched.eval.id]);
    // Its copies never answer: their time runs out.
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await c.query(`UPDATE wf_instances SET deadline_at = now(),
                       data = jsonb_set(data, ARRAY['trials', $1::text, 'due'], to_jsonb(now()::text))
                      WHERE machine = 'shots-eval'`, [String(trial.id)]);
      await c.query('COMMIT');
    } finally { c.release(); }
    await rt.fireTimers();
    await rt.drain();
    const work = async (kind) => (await pool.query(
      `SELECT status, created_at, settled_at FROM wf_work WHERE machine = 'shots-eval' AND kind = $1 AND work_key LIKE $2`,
      [kind, `${kind.split('.')[1]}:${trial.id}:%`])).rows[0];
    // Its copies are not abandoned to build on beside a cleanup: told to
    // stop (the row says so), and the cleanup waits for them.
    assert.equal((await work('eval.copies')).status, 'queued');
    assert.equal(await work('eval.cleanup'), undefined, 'no cleanup while its copies may still build');
    const { rows: [stopping] } = await pool.query('SELECT state, stopping_at FROM shots_eval_trials WHERE id = $1', [trial.id]);
    assert.equal(stopping.state, 'provisioning');
    assert.ok(stopping.stopping_at, 'its work stops at its next step');
    const env = require('../src/services/shots-environment');
    const real = env.preparePair;
    let built = 0;
    env.preparePair = async (...args) => { built += 1; return real(...args); };
    try { await settle(); } finally { env.preparePair = real; }
    assert.equal(built, 0, 'its copies stopped before building anything more');
    const copies = await work('eval.copies');
    const cleanup = await work('eval.cleanup');
    assert.ok(cleanup && copies.settled_at <= cleanup.created_at, 'cleaned up once its copies had stopped');
    const { rows: [ended] } = await pool.query('SELECT state, failure_code FROM shots_eval_trials WHERE id = $1', [trial.id]);
    assert.deepEqual(ended, { state: 'failed', failure_code: 'shots_eval_timeout' });
  });

  await t.test('a trial cancelled while its copies are built stops at their next phase', async () => {
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    await lookNow();
    await rt.drain();
    const { rows: [trial] } = await pool.query('SELECT id, attempt_id FROM shots_eval_trials WHERE eval_run_id = $1', [launched.eval.id]);
    // Cancelled between its claim and its copies' second phase: what was
    // built is not reset, and the agent never runs.
    const env = require('../src/services/shots-environment');
    const real = env.preparePair;
    const before = dispatched.length;
    let reset = 0;
    const realReset = env.resetPair;
    env.preparePair = async (...args) => {
      await evals.cancelRun(pool, launched.eval.id, { platform: { evalCancel: async () => ({ status: 'accepted' }) } }).catch(() => null);
      await pool.query(`UPDATE shots_eval_trials SET state = 'cancelled' WHERE id = $1`, [trial.id]);
      return real(...args);
    };
    env.resetPair = async (...args) => { reset += 1; return realReset(...args); };
    try {
      await settle();
    } finally { env.preparePair = real; env.resetPair = realReset; }
    assert.equal(reset, 0, 'its copies stopped at the next phase');
    assert.equal(dispatched.length, before, 'its agent never ran');
    const { rows: [ended] } = await pool.query('SELECT state FROM shots_eval_trials WHERE id = $1', [trial.id]);
    assert.equal(ended.state, 'cancelled');
    assert.ok(world.removed.includes(trial.attempt_id), 'what it built removed');
    await pool.query(`UPDATE shots_eval_runs SET status = 'done' WHERE id = $1 AND status = 'running'`, [launched.eval.id]);
  });

  await t.test('an eval\'s model calls are its trial\'s by the turn\'s owner, not by the session', async () => {
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 1 + 3 });
    const { rows: [trial] } = await pool.query('SELECT id, attempt_id FROM shots_eval_trials WHERE eval_run_id = $1', [launched.eval.id]);
    await asTransition(pool, `UPDATE shots_eval_trials SET state = 'exploring' WHERE id = $1`, [trial.id]);
    const turn = (owner) => pool.query('UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1',
      [MERGED_TWO, JSON.stringify({ turnId: 't1', mode: 'shots', owner })]);
    // The eval machine's agent work owns it: billed to the trial.
    await turn({ machine: 'shots-eval', key: 'evals', kind: 'eval.agent', workKey: `agent:${trial.id}:${trial.attempt_id}:1`, workId: 'w' });
    const bill = await evals.billFor(pool, MERGED_TWO);
    assert.equal(bill.trialId, trial.id);
    assert.equal(bill.overCap(0), false);
    await bill.noteSpend(350);
    assert.equal(bill.overCap(100), true, 'past the eval\'s $4 cap');
    const { rows: [t1] } = await pool.query('SELECT proxy_cents::float8 AS p FROM shots_eval_attempt_costs WHERE attempt_id = $1', [trial.attempt_id]);
    assert.equal(t1.p, 350, 'on its attempt\'s costs');
    // The proposal's own shots turn on the same session: never the eval's.
    await turn({ machine: 'shots', key: `session:${MERGED_TWO}`, kind: 'shots.agent', workKey: 'agent:1', workId: 'w' });
    assert.equal(await evals.billFor(pool, MERGED_TWO), null);
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [MERGED_TWO]);
    await pool.query(`UPDATE shots_eval_runs SET status = 'done' WHERE id = $1`, [launched.eval.id]);
    await asTransition(pool, `UPDATE shots_eval_trials SET state = 'failed' WHERE id = $1`, [trial.id]);
  });

  await t.test('a trial\'s cleanup leaves the proposal\'s worker to its own shots run, and theirs to a trial', async () => {
    const live = await pool.query(`SELECT 1`);
    void live;
    // The proposal's own shots under way: the worker stays.
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await c.query(`INSERT INTO wf_instances (machine, key, state, data, machine_version) VALUES ('shots', $1, 'taking_shots', '{"run": {"id": "x"}}'::jsonb, 1)`, [`session:${MERGED_TWO}`]);
      await c.query('COMMIT');
    } finally { c.release(); }
    world.destroyed.length = 0;
    await orchestrator.cleanupRun(CONFIG, pool, { runId: 'f'.repeat(32), sessionId: MERGED_TWO, appSlug: 'eval-demo', worker: true });
    assert.deepEqual(world.destroyed, [], 'kept for the proposal\'s own run');
    await pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'; DELETE FROM wf_instances WHERE machine = 'shots' AND key = 'session:${MERGED_TWO}'; COMMIT`);
    // A trial of it under way: the proposal's own cleanup keeps it too.
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    const { rows: [trial] } = await pool.query('SELECT id FROM shots_eval_trials WHERE eval_run_id = $1', [launched.eval.id]);
    await asTransition(pool, `UPDATE shots_eval_trials SET state = 'exploring' WHERE id = $1`, [trial.id]);
    await orchestrator.cleanupRun(CONFIG, pool, { runId: '1'.repeat(32), sessionId: MERGED_TWO, appSlug: 'eval-demo', worker: true });
    assert.deepEqual(world.destroyed, [], 'kept for the trial');
    await asTransition(pool, `UPDATE shots_eval_trials SET state = 'failed' WHERE id = $1`, [trial.id]);
    await pool.query(`UPDATE shots_eval_runs SET status = 'done' WHERE id = $1`, [launched.eval.id]);
    await orchestrator.cleanupRun(CONFIG, pool, { runId: '1'.repeat(32), sessionId: MERGED_TWO, appSlug: 'eval-demo', worker: true });
    assert.deepEqual(world.destroyed, [MERGED_TWO], 'nothing else on it: removed');
  });

  await t.test('only the eval machine claims a trial or puts one back: an older build\'s runner is refused', async () => {
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    const { rows: [trial] } = await pool.query('SELECT id FROM shots_eval_trials WHERE eval_run_id = $1', [launched.eval.id]);
    await assert.rejects(pool.query("UPDATE shots_eval_trials SET state = 'provisioning' WHERE id = $1 AND state = 'planned'", [trial.id]), /WF_OWNERSHIP_VIOLATION/);
    await asTransition(pool, "UPDATE shots_eval_trials SET state = 'exploring' WHERE id = $1", [trial.id]);
    await assert.rejects(pool.query("UPDATE shots_eval_trials SET state = 'planned' WHERE id = $1", [trial.id]), /WF_OWNERSHIP_VIOLATION/);
    await asTransition(pool, "UPDATE shots_eval_trials SET state = 'failed' WHERE id = $1", [trial.id]);
    await pool.query(`UPDATE shots_eval_runs SET status = 'done' WHERE id = $1`, [launched.eval.id]);
  });

  await t.test('the GC keeps a running trial\'s checkout and prunes old trial images', async () => {
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    const { rows: [trial] } = await pool.query('SELECT id, attempt_id FROM shots_eval_trials WHERE eval_run_id = $1', [launched.eval.id]);
    await pool.query(`UPDATE shots_eval_trials SET state = 'exploring', updated_at = NOW() WHERE id = $1`, [trial.id]);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-gc-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const live = `usernode-shots-${trial.attempt_id.slice(0, 8)}-live`;
    const orphan = 'usernode-shots-0f0f0f0f-orphan';
    for (const name of [live, orphan]) {
      fs.mkdirSync(path.join(tmpDir, name));
      const old = new Date(Date.now() - 600_000);
      fs.utimesSync(path.join(tmpDir, name), old, old);
    }
    const swept = await shotsGc.sweepOrphanCheckouts(pool, { maxAgeMs: 60_000, tmpDir });
    assert.equal(swept.removed, 1);
    assert.deepEqual(fs.readdirSync(tmpDir), [live]);

    await pool.query(`UPDATE shots_eval_trials SET completed_at = NOW() - interval '40 days' WHERE eval_run_id = $1`, [evalId]);
    assert.equal(await shotsGc.pruneEvalArtifacts(pool), 4);
    const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM shots_eval_artifacts');
    assert.equal(n, 0);
    const { rows: [kept] } = await pool.query(`SELECT COUNT(*)::int AS n FROM shots_eval_trials WHERE eval_run_id = $1 AND state = 'verified'`, [evalId]);
    assert.equal(kept.n, 2, 'the trials keep their results');
  });
  // ── What a rollout, a restart or a lost ask leaves (the step 4 review) ──

  const closeEvals = async () => {
    await settle();
    await pool.query("UPDATE shots_eval_runs SET status = 'done' WHERE status = 'running'");
    await asTransition(pool, "UPDATE shots_eval_trials SET state = 'failed', completed_at = NOW() WHERE state IN ('planned', 'provisioning', 'exploring', 'reviewing')");
    await pool.query('UPDATE chat_sessions SET active_turn = NULL');
    await settle();
  };
  const estimate = async () => (await require('../src/workflow/shots-eval/facts.ts').readFacts(pool, {})).estimateCents;
  const tick = async () => {
    await rt.append(evalMachine.MACHINE, evalMachine.KEY, { type: 'Tick', payload: {} }, { requestKey: `tick-${++rk}`, source: { kind: 'system', name: 'test' } });
    await rt.drain();
  };
  const trialsOf = async (id) => (await pool.query(
    'SELECT id, attempt_id, state, session_id, cost_cents::float8 AS cost, recipe, updated_at, stopping_at FROM shots_eval_trials WHERE eval_run_id = $1 ORDER BY position', [id])).rows;
  const evalRow = async (id) => (await pool.query('SELECT status, spent_cents::float8 AS spent, cap_cents::float8 AS cap FROM shots_eval_runs WHERE id = $1', [id])).rows[0];

  await t.test('E1: a trial\'s cost counts against its eval\'s cap in the very step that ends it', async () => {
    await closeEvals();
    const e = await estimate();
    // Room for one trial at its estimate, not two; the first costs the estimate.
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED, MERGED_TWO], capUsd: (1.5 * e) / 100 });
    assert.equal(launched.ok, true, JSON.stringify(launched));
    world.restore();
    const before = dispatched.length;
    world = fakeOutsideWorld({ dispatched, costUsd: 0.01, hold: async (options) => {
      const { rows: [tr] } = await pool.query('SELECT id FROM shots_eval_trials WHERE attempt_id = $1', [options.runId]);
      await require('../src/workflow/shots-eval/costs.ts').addCost(pool, { trialId: tr.id, attemptId: options.runId, proxyCents: e });
    } });
    try {
      await lookNow();
      await settle();
    } finally { world.restore(); world = fakeOutsideWorld({ dispatched }); }
    assert.equal(dispatched.length - before, 1, 'the second never ran: what the first cost leaves no room for it');
    const ev = await evalRow(launched.eval.id);
    assert.equal(ev.status, 'capped');
    assert.ok(ev.spent <= ev.cap, `spent ${ev.spent} of ${ev.cap}`);
  });

  await t.test('E2: the rows of the trials it runs are not beaten: nothing reads their age', async () => {
    await closeEvals();
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    await lookNow();
    await rt.drain();
    const [trial] = await trialsOf(launched.eval.id);
    assert.equal(trial.state, 'provisioning');
    await pool.query("UPDATE shots_eval_trials SET updated_at = NOW() - interval '10 minutes' WHERE id = $1", [trial.id]);
    await tick();
    const { rows: [row] } = await pool.query('SELECT updated_at < NOW() - interval \'5 minutes\' AS old FROM shots_eval_trials WHERE id = $1', [trial.id]);
    assert.equal(row.old, true);
    assert.equal(evalMachine.BEAT_MS, undefined);
    await closeEvals();
  });


  const costOf = async (attemptId) => (await pool.query(
    `SELECT proxy_cents::float8 AS proxy, reported_cents::float8 AS reported, charged_cents::float8 AS charged, settled_at IS NOT NULL AS settled
       FROM shots_eval_attempt_costs WHERE attempt_id = $1`, [attemptId])).rows[0];
  const ownedTurn = (trial) => ({ turnId: 't', mode: 'shots', owner: { machine: 'shots-eval', key: 'evals', kind: 'eval.agent', workKey: `agent:${trial.id}:${trial.attempt_id}:1`, workId: 'w' } });
  const setTurn = (sessionId, t2) => pool.query('UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1', [sessionId, JSON.stringify(t2)]);
  // An attempt ended (settled) by the machine's own end, as its cleanup writes it.
  const settle1 = async (trial) => {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await require('../src/workflow/shots-eval/costs.ts').settleAttempt(c, { trialId: trial.id, attemptId: trial.attempt_id });
      await c.query(`UPDATE shots_eval_trials SET state = 'failed', completed_at = NOW() WHERE id = $1`, [trial.id]);
      await c.query('COMMIT');
    } finally { c.release(); }
  };

  await t.test('E3: a call reaching any process bills the trial its owner names: a straggler, a trial put back; a turn nothing owns is no trial\'s', async () => {
    await closeEvals();
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    const [trial] = await trialsOf(launched.eval.id);
    await asTransition(pool, `UPDATE shots_eval_trials SET state = 'exploring' WHERE id = $1`, [trial.id]);
    // A shots turn nothing owns, correlated with the attempt (what an older
    // release's runner dispatched): no eval's, so never the platform's to pay.
    await setTurn(MERGED_TWO, { turnId: 't', mode: 'shots', telemetryCorrelationId: trial.attempt_id });
    assert.equal(await evals.billFor(pool, MERGED_TWO), null);
    // The machine's turn: on its attempt's costs, and only those.
    await setTurn(MERGED_TWO, ownedTurn(trial));
    const bill = await evals.billFor(pool, MERGED_TWO);
    await bill.noteSpend(5);
    await settle1(trial);
    assert.equal((await trialsOf(launched.eval.id))[0].cost, 5);
    // A straggler after its end: what it adds charged at once.
    await bill.noteSpend(5);
    assert.equal((await trialsOf(launched.eval.id))[0].cost, 10);
    assert.equal((await evalRow(launched.eval.id)).spent, 10);
    // Put back under a new attempt meanwhile: the old attempt's call is still the trial's.
    await asTransition(pool, `UPDATE shots_eval_trials SET state = 'planned', attempt_id = $2 WHERE id = $1`, [trial.id, '6'.repeat(32)]);
    const again = await evals.billFor(pool, MERGED_TWO);
    assert.equal(again?.trialId, trial.id, 'never the author\'s');
    await again.noteSpend(5);
    assert.equal((await trialsOf(launched.eval.id))[0].cost, 15);
    assert.equal((await evalRow(launched.eval.id)).spent, 15);
    await closeEvals();
  });

  await t.test('E3b: a cost reported after the trial ended is charged; a late call charges only what it adds to the larger total', async () => {
    await closeEvals();
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    const [trial] = await trialsOf(launched.eval.id);
    await asTransition(pool, `UPDATE shots_eval_trials SET state = 'exploring' WHERE id = $1`, [trial.id]);
    // Cancelled and cleaned up before its agent's dispatch returned: then it reports 37.
    await settle1(trial);
    assert.equal((await trialsOf(launched.eval.id))[0].cost, 0);
    await evals.noteReported(pool, trial.id, trial.attempt_id, 37);
    assert.equal((await trialsOf(launched.eval.id))[0].cost, 37, 'the late report charged');
    assert.equal((await evalRow(launched.eval.id)).spent, 37);
    await closeEvals();

    const second = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    const [t2] = await trialsOf(second.eval.id);
    await asTransition(pool, `UPDATE shots_eval_trials SET state = 'exploring' WHERE id = $1`, [t2.id]);
    await setTurn(MERGED_TWO, ownedTurn(t2));
    const bill = await evals.billFor(pool, MERGED_TWO);
    await evals.noteReported(pool, t2.id, t2.attempt_id, 50);
    await bill.noteSpend(10);
    await settle1(t2);
    assert.equal((await trialsOf(second.eval.id))[0].cost, 50, 'the larger of 50 reported and 10 proxied');
    await bill.noteSpend(10);
    assert.equal((await trialsOf(second.eval.id))[0].cost, 50, '20 proxied is still under the 50 charged: nothing more');
    await bill.noteSpend(40);
    assert.equal((await trialsOf(second.eval.id))[0].cost, 60, '60 proxied: only the 10 it adds over 50');
    assert.equal((await evalRow(second.eval.id)).spent, 60);
    assert.deepEqual(await costOf(t2.attempt_id), { proxy: 60, reported: 50, charged: 60, settled: true });
    await closeEvals();
  });

  await t.test('E4: with nothing to do it still looks again, so a lost ask to look waits only so long', async () => {
    await closeEvals();
    await lookNow();
    await rt.drain();
    const { rows: [inst] } = await pool.query("SELECT deadline_at FROM wf_instances WHERE machine = 'shots-eval'");
    assert.ok(inst.deadline_at, 'a look is due');
    const inMs = Date.parse(inst.deadline_at) - Date.now();
    assert.ok(inMs > 5 * 60 * 1000 && inMs <= evalMachine.IDLE_LOOK_MS, String(inMs));
  });

  await t.test('E5: a trial whose row was ended elsewhere is stopped and cleaned up', async () => {
    await closeEvals();
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    world.restore();
    world = fakeOutsideWorld({ dispatched, hold: () => new Promise(() => {}) });
    try {
      await lookNow();
      await rt.drain();
      await rt.runServices(); // the copies
      await rt.drain();
      const [trial] = await trialsOf(launched.eval.id);
      assert.equal(trial.state, 'exploring');
      void rt.runServices(); // its agent, which never returns
      await new Promise((r) => setTimeout(r, 100));
      // A write of the row and nothing else.
      await pool.query(`UPDATE shots_eval_trials SET state = 'cancelled' WHERE id = $1`, [trial.id]);
      await tick();
      const { rows: [w] } = await pool.query(
        `SELECT input FROM wf_work WHERE machine = 'shots-eval' AND kind = 'eval.cleanup' AND work_key = $1`, [`cleanup:${trial.id}:${trial.attempt_id}`]);
      assert.equal(w?.input.stopTurn, true, 'cleaned up, its turn stopped');
      await settle();
      assert.ok(world.removed.includes(trial.attempt_id));
      const [ended] = await trialsOf(launched.eval.id);
      assert.equal(ended.state, 'cancelled');
    } finally { world.restore(); world = fakeOutsideWorld({ dispatched }); }

    await closeEvals();
  });

  await t.test('E6: no trial starts on a proposal with a turn under way; it starts once the turn is over', async () => {
    await closeEvals();
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    await pool.query('UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1', [MERGED_TWO, JSON.stringify({ turnId: 'x', mode: 'shots' })]);
    await lookNow();
    await rt.drain();
    assert.equal((await trialsOf(launched.eval.id))[0].state, 'planned', 'waits for the turn');
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [MERGED_TWO]);
    await lookNow();
    await rt.drain();
    assert.equal((await trialsOf(launched.eval.id))[0].state, 'provisioning');
    await closeEvals();
  });

  await t.test('E7: an eval whose many trials all wait holds none of a later eval\'s back', async () => {
    await closeEvals();
    const a = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 100 });
    const [first] = await trialsOf(a.eval.id);
    // Thirty-five more of it, on proposals all busy.
    await pool.query(
      `INSERT INTO shots_eval_trials (eval_run_id, session_id, config_id, repetition, position, attempt_id, base_sha, head_sha, intent)
       SELECT $1, s, c, r, 100 + ROW_NUMBER() OVER (), md5(random()::text || s || COALESCE(c, 0) || r), t.base_sha, t.head_sha, t.intent
         FROM shots_eval_trials t,
              unnest($2::int[]) s, unnest(ARRAY[NULL::int] || (SELECT array_agg(id) FROM shots_eval_configs)) c, generate_series(1, 3) r
        WHERE t.id = $3 AND NOT (s = $4 AND c IS NULL AND r = 1)`,
      [a.eval.id, [MERGED_TWO, OPEN, NO_RUN, NO_CHANGE], first.id, MERGED_TWO]);
    await pool.query('UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = ANY($1::int[])',
      [[MERGED_TWO, OPEN, NO_RUN, NO_CHANGE], JSON.stringify({ turnId: 'x', mode: 'chat' })]);
    assert.ok((await trialsOf(a.eval.id)).length > 20);
    const b = await evals.launch(pool, CONFIG, { sessionIds: [MERGED], capUsd: 10 });
    await lookNow();
    await rt.drain();
    assert.equal((await trialsOf(b.eval.id))[0].state, 'provisioning', 'the later eval\'s trial starts');
    await closeEvals();
  });

  await t.test('E8: a trial says what it ran with from its start, even one whose copies fail', async () => {
    await closeEvals();
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    const env = require('../src/services/shots-environment');
    const real = env.preparePair;
    env.preparePair = async () => { throw new Error('no node for the copies'); };
    try {
      await lookNow();
      await settle();
    } finally { env.preparePair = real; }
    const [trial] = await trialsOf(launched.eval.id);
    assert.equal(trial.state, 'failed');
    assert.ok(trial.recipe, 'its recipe kept');
    await closeEvals();
  });

  await t.test('E9: a claim another process changed meanwhile starts no work; the grant is decided again', async () => {
    await closeEvals();
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    await pool.query(`CREATE SEQUENCE e9_miss;
      CREATE FUNCTION e9_miss() RETURNS trigger AS $$
      BEGIN IF OLD.state = 'planned' AND NEW.state = 'provisioning' AND nextval('e9_miss') = 1 THEN RETURN NULL; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER e9_miss BEFORE UPDATE ON shots_eval_trials FOR EACH ROW EXECUTE FUNCTION e9_miss();`);
    try {
      await lookNow();
      await rt.drain();
      const [trial] = await trialsOf(launched.eval.id);
      const copies = async () => (await pool.query(
        `SELECT COUNT(*)::int AS n FROM wf_work WHERE machine = 'shots-eval' AND kind = 'eval.copies' AND work_key LIKE $1`, [`copies:${trial.id}:%`])).rows[0].n;
      assert.equal(trial.state === 'planned' ? await copies() : 1, trial.state === 'planned' ? 0 : 1, 'work only for a claim that happened');
      for (let i = 0; i < 20 && (await trialsOf(launched.eval.id))[0].state === 'planned'; i += 1) {
        await new Promise((r) => setTimeout(r, 200));
        await rt.drain();
      }
      assert.equal((await trialsOf(launched.eval.id))[0].state, 'provisioning');
      assert.equal(await copies(), 1);
    } finally {
      await pool.query('DROP TRIGGER e9_miss ON shots_eval_trials; DROP FUNCTION e9_miss(); DROP SEQUENCE e9_miss');
    }
    await closeEvals();
  });

  await t.test('E10: while two releases serve, a trial starts all the same: every release bills its calls to it', async () => {
    await closeEvals();
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    await pool.query(`INSERT INTO platform_processes (id, release, state) VALUES ('old-pod', 'a1', 'serving'), ('new-pod', 'b2', 'serving')`);
    try {
      await lookNow();
      await rt.drain();
      assert.equal((await trialsOf(launched.eval.id))[0].state, 'provisioning');
    } finally { await pool.query(`DELETE FROM platform_processes WHERE id IN ('old-pod', 'new-pod')`); }
    await closeEvals();
  });


  await t.test('E11: what Claude Code reported a dispatch cost is on its attempt\'s costs as it returns', async () => {
    await closeEvals();
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    world.restore();
    let reported = null;
    world = fakeOutsideWorld({ dispatched, costUsd: 0.37 });
    try {
      await lookNow();
      await rt.drain();
      await rt.runServices(); // copies
      await rt.drain();
      await rt.runServices(); // agent
      const [trial] = await trialsOf(launched.eval.id);
      reported = (await costOf(trial.attempt_id)).reported;
      await settle();
    } finally { world.restore(); world = fakeOutsideWorld({ dispatched }); }
    assert.equal(reported, 37, 'kept before the trial ends');
    const [ended] = await trialsOf(launched.eval.id);
    assert.equal(ended.cost, 37, 'charged the larger of what the proxy saw (nothing) and what was reported');
    await closeEvals();
  });
});
