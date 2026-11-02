'use strict';
const mediaStore = require('../src/services/media-store');
const mediaTestStore = require('./lib/media-store').useMemoryMedia(require('node:test'));
const { fixtureKey } = require('./lib/media-store');

// The shots machine (src/workflow/shots/) against the full PostgreSQL
// schema: a proposal's declaration, its runs (revision, copies, the agent's
// turn, publication, cleanup), the preview machine's messages, a person's
// Retry, Stop and waiver, the automatic retries, the adoption of a run
// [main] was taking, and the ownership guard on the slot and the runs. The
// work is fake; the real steps are services/shots-orchestrator.js's.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/workflow-shots-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { shots, sessionKey, MACHINE, WORK } = require('../src/workflow/shots/machine.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);
const RUN = /^[0-9a-f]{32}$/;

const INTENT = (impact = 'ui', claim = 'The card shows the new badge') => ({
  version: 1, impact, rationale: impact === 'none' ? 'Backend only.' : null,
  stories: impact === 'none' ? [] : [{
    id: 'c1', claim, persona: 'member',
    viewports: [{ name: 'desktop', width: 1280, height: 800 }],
    intent: { startPath: '/', steps: ['Open the home page'], baseState: 'present', animation: 'none' },
  }],
});

test('shots machine against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_shots_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 10 });
  pool.on('error', () => {});
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:${MACHINE}', '1') ON CONFLICT DO NOTHING`);

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  async function user() {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [`sh_${++seq}`]);
    return u;
  }
  // The proposals are the Homeroom bot's: whoever waits on the slot hears
  // it settled through its change machine (a write of the settle's own,
  // rules/bot-notes.ts).
  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`);
  const settledTold = async (s) => (await pool.query(
    `SELECT count(*)::int AS n FROM wf_events WHERE machine = 'bot-change' AND key = $1 AND type = 'ShotsSettled'`,
    [`session:${s.id}`])).rows[0].n;
  async function proposal({ status = 'promoted', source = null, head = SHA('a'), ready = false } = {}) {
    const owner = await user();
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, repo_url) VALUES ($1::text, $1::text, $2, 'https://github.com/acme/' || $1::text) RETURNING *`,
      [`sh-app-${++seq}`, owner.id]);
    const by = botUser;
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, source, branch_name, pr_number, reviewed_head_sha, imported_pr_head_sha,
                                  staging_commit_sha, staging_url)
       VALUES ($1, $2, $3, $4, 'feature', $5, $6, $7, $8, $9) RETURNING *`,
      [a.id, by.id, status, source, ++seq, source === 'imported' ? null : head, source === 'imported' ? head : null,
        ready ? head : null, ready ? 'https://preview.test' : null]);
    return { ...s, app: a };
  }
  const row = async (s) => (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [s.id])).rows[0];
  const instance = async (s) => (await pool.query(
    'SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(s.id)])).rows[0];
  const runs = async (s) => (await pool.query(
    'SELECT * FROM shot_runs WHERE session_id = $1 ORDER BY created_at, id', [s.id])).rows;
  const workOf = async (s, kind) => (await pool.query(
    `SELECT kind, work_key, input, status, result FROM wf_work WHERE machine = $1 AND key = $2 AND ($3::text IS NULL OR kind = $3)
      ORDER BY created_at, work_key`, [MACHINE, sessionKey(s.id), kind || null])).rows;
  const asTransition = async (fn) => {
    const c = await pool.connect();
    try { await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`); await fn(c); await c.query('COMMIT'); } finally { c.release(); }
  };
  const due = (s) => asTransition((c) => c.query(
    'UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(s.id)]));

  // The agent's workspace, as the copies step writes it and the agent's
  // calls fill it (services/shots-control.js).
  async function workspace(runId, sessionId) {
    await pool.query(
      `INSERT INTO shot_run_control (run_id, session_id, intent, context, expires_at)
       VALUES ($1, $2, $3::jsonb, '{}'::jsonb, NOW() + INTERVAL '1 hour') ON CONFLICT DO NOTHING`,
      [runId, sessionId, JSON.stringify(INTENT())]);
  }
  const PNG = Buffer.from('fake-png');
  async function saved(runId, side) {
    await pool.query(
      `INSERT INTO shot_run_files (run_id, slot, story_id, viewport, side, variant, media, content_type, object_key, bytes, sha256)
       VALUES ($1, $2, 'c1', 'desktop', $3, 'context', 'png', 'image/png', $4, $5, $6)`,
      [runId, `c1/desktop/${side}/context`, side, await fixtureKey(pool, PNG), PNG.length, crypto.createHash('sha256').update(side).digest('hex')]);
  }
  const READY_VERDICT = { passed: true, mode: 'shots', runs: 1, stories: [{ id: 'c1', status: 'ready', files: 2 }] };
  const passed = (input) => ({
    agent: { outcome: 'completed' }, passed: true, readyCount: 1, failedCount: 0, verdict: READY_VERDICT,
    manifestHash: 'f'.repeat(64), slots: ['base', 'head'].map((side) => `c1/desktop/${side}/context`),
    skippedAny: false, trace: { runId: input.runId },
  });

  // Fake work: each call recorded; `answer` per kind (a value, or a
  // function of the input).
  const work = { calls: [], answer: new Map() };
  const fake = (kind) => ({
    maxAttempts: 2, backoffMs: () => 0, leaseMs: 600,
    async run({ input, key }) {
      work.calls.push({ kind, key, input });
      const a = work.answer.get(kind);
      return typeof a === 'function' ? await a(input) : (a ?? { ok: true });
    },
  });
  const defaults = () => {
    work.calls.length = 0;
    work.answer.set(WORK.revision, () => ({ baseSha: SHA('0') }));
    work.answer.set(WORK.copies, async (input) => {
      await workspace(input.runId, input.sessionId);
      return { fixtureFingerprint: 'fp', baseImageDigest: 'sha256:base', headImageDigest: 'sha256:head', afterOnly: false };
    });
    work.answer.set(WORK.agent, async (input) => {
      await saved(input.runId, 'base');
      await saved(input.runId, 'head');
      return passed(input);
    });
    work.answer.set(WORK.publish, (input) => ({ verdict: { ...input.verdict, screens: [{ change: 'c1' }] } }));
    work.answer.set(WORK.cleanup, async (input) => {
      await pool.query('DELETE FROM shot_run_control WHERE run_id = $1', [input.runId]);
      return { cleaned: true, version: 2 };
    });
  };
  defaults();
  const pushed = [];
  const machine = shots({ execute: true, agentBudgetMs: 480000, runBudgetMs: 1440000 });
  const rt = createRuntime({
    pool, machines: [machine], pollMs: 50, publish: async (q, list) => { pushed.push(...list); },
    services: Object.fromEntries(Object.values(WORK).map((k) => [k, fake(k)])),
  });
  runtimes.push(rt);

  let rk = 0;
  const send = (s, type, payload = {}, source = { kind: 'system' }) => rt.append(machine, sessionKey(s.id),
    { type, payload: { sessionId: s.id, ...payload } }, { requestKey: `t-${++rk}`, source, appId: s.app_id });
  const fromPreview = { kind: 'message', from: { machine: 'preview', key: 'x', eventId: 1 } };
  const route = { kind: 'route' };
  const settle = async () => {
    for (let i = 0; i < 30; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  const outcome = async (id) => (await pool.query('SELECT result, reason, state_after FROM wf_events WHERE id = $1', [id])).rows[0];
  const declare = (s, intent = INTENT(), head = null) => send(s, 'Declared', { intent, head }, route);
  const calls = (kind) => work.calls.filter((c) => c.kind === kind);

  await t.test('S1 a declared head ready to be shot: revision, copies, the agent, publication, cleanup', async () => {
    defaults();
    const s = await proposal();
    await declare(s);
    await rt.drain();
    let r = await row(s);
    assert.equal((await instance(s)).state, 'waiting_for_preview');
    assert.equal(r.shots_state, 'planned');
    assert.equal(r.shots_run_id, null);
    assert.equal(r.shots_detail.required, true);
    assert.equal(r.shots_detail.headSha, SHA('a'));
    await send(s, 'HeadReady', { head: SHA('a') }, fromPreview);
    await settle();
    const i = await instance(s);
    assert.equal(i.state, 'published');
    const [run] = await runs(s);
    assert.match(run.id, RUN);
    assert.equal(run.state, 'verified');
    assert.equal(run.base_sha, SHA('0'));
    assert.equal(run.fixture_fingerprint, 'fp');
    assert.equal(run.plan_hash, 'f'.repeat(64));
    assert.deepEqual(run.hard_verdict.screens, [{ change: 'c1' }], 'the comparison\'s outlines are published');
    assert.equal(run.trace_summary.cleanupComplete, true, 'the cleanup is recorded on the run');
    r = await row(s);
    assert.equal(r.shots_state, 'verified');
    assert.equal(r.shots_run_id, run.id);
    assert.equal(r.shots_detail.artifactSummary.length, 2, 'the saved files became the run\'s shots');
    const { rows: arts } = await pool.query('SELECT side, object_key FROM shot_artifacts WHERE run_id = $1 ORDER BY side', [run.id]);
    assert.deepEqual(await Promise.all(arts.map(async (a) => [a.side, (await mediaStore.bytes(mediaTestStore, a)).toString()])), [['base', 'fake-png'], ['head', 'fake-png']]);
    assert.equal((await pool.query('SELECT 1 FROM shot_run_control WHERE run_id = $1', [run.id])).rowCount, 0, 'workspace gone');
    assert.deepEqual(calls(WORK.cleanup).map((c) => [c.input.runId, c.input.stopTurn, c.input.worker]), [[run.id, true, false]]);
    assert.ok(await settledTold(s) >= 1, 'the bot hears the slot settled');
    assert.ok(calls(WORK.prBlock).length >= 2, 'the PR block at the run\'s start and when it settles');
    assert.ok(pushed.some((p) => p.data.type === 'vote_update' && p.data.action === 'shots' && p.data.shotsState === 'verified'));
    // The same head again stands: nothing is taken twice.
    const before = work.calls.length;
    await send(s, 'HeadReady', { head: SHA('a') }, fromPreview);
    await settle();
    assert.equal(work.calls.length, before, 'no new run');
  });

  // Dark shots (#4459) are whole screens taken in dark mode and stored as
  // their own slots: publication copies their theme, and the light and dark
  // copies of one slot both become artifacts under the run.
  await t.test('S9 a dark shot publishes beside its light copy, with its theme', async () => {
    defaults();
    const DARK = Buffer.from('fake-png-dark');
    work.answer.set(WORK.agent, async (input) => {
      await saved(input.runId, 'base');
      await saved(input.runId, 'head');
      await pool.query(
        `INSERT INTO shot_run_files (run_id, slot, story_id, viewport, side, variant, media, theme, content_type, object_key, bytes, sha256)
         VALUES ($1, $2, 'c1', 'desktop', 'head', 'context', 'png', 'dark', 'image/png', $3, $4, $5)`,
        [input.runId, 'c1/desktop/head/context/dark', await fixtureKey(pool, DARK), DARK.length,
          crypto.createHash('sha256').update('dark').digest('hex')]);
      return { ...passed(input), slots: [...passed(input).slots, 'c1/desktop/head/context/dark'] };
    });
    const s = await proposal();
    await declare(s);
    await rt.drain();
    await send(s, 'HeadReady', { head: SHA('a') }, fromPreview);
    await settle();
    const [run] = await runs(s);
    assert.equal(run.state, 'verified');
    const { rows: arts } = await pool.query(
      'SELECT side, theme, object_key FROM shot_artifacts WHERE run_id = $1 ORDER BY side, theme', [run.id]);
    assert.deepEqual(await Promise.all(arts.map(async (a) => [a.side, a.theme, (await mediaStore.bytes(mediaTestStore, a)).toString()])), [
      ['base', 'light', 'fake-png'], ['head', 'dark', 'fake-png-dark'], ['head', 'light', 'fake-png'],
    ], 'light and dark of one slot coexist, each with its theme');
    const summary = (await row(s)).shots_detail.artifactSummary;
    assert.deepEqual(summary.map((a) => [a.side, a.theme]), [['base', 'light'], ['head', 'dark'], ['head', 'light']]);
  });

  // A run taken at device density (services/shots-density.js) keeps each
  // dense still twice: object_key its 1x copy, dense_* the original. Publication
  // copies both, and the database holds the pair together.
  await t.test('S9b a dense still publishes with its 1x copy and its original', async () => {
    defaults();
    const DENSE = Buffer.from('fake-png-dense');
    work.answer.set(WORK.agent, async (input) => {
      await saved(input.runId, 'base');
      await pool.query(
        `INSERT INTO shot_run_files (run_id, slot, story_id, viewport, side, variant, media, content_type, object_key, width, height, bytes, sha256,
                                     density, dense_object_key, dense_width, dense_height, dense_bytes, dense_sha256)
         VALUES ($1, 'c1/desktop/head/context', 'c1', 'desktop', 'head', 'context', 'png', 'image/png', $2, 1280, 800, $3, $4,
                 2, $5, 2560, 1600, $6, $7)`,
        [input.runId, await fixtureKey(pool, Buffer.from('fake-png')), 8, crypto.createHash('sha256').update('flat').digest('hex'),
          await fixtureKey(pool, DENSE), DENSE.length, crypto.createHash('sha256').update('dense').digest('hex')]);
      return passed(input);
    });
    const s = await proposal();
    await declare(s);
    await rt.drain();
    await send(s, 'HeadReady', { head: SHA('a') }, fromPreview);
    await settle();
    const [run] = await runs(s);
    assert.equal(run.state, 'verified');
    const { rows: [head] } = await pool.query(
      `SELECT object_key, width, density, dense_object_key, dense_width, dense_height FROM shot_artifacts WHERE run_id = $1 AND side = 'head'`, [run.id]);
    assert.deepEqual([(await mediaStore.bytes(mediaTestStore, head)).toString(), head.width, head.density, (await mediaStore.bytes(mediaTestStore, head, { key: 'dense_object_key' })).toString(), head.dense_width, head.dense_height],
      ['fake-png', 1280, 2, 'fake-png-dense', 2560, 1600]);
    const { rows: [base] } = await pool.query(
      `SELECT density, dense_object_key FROM shot_artifacts WHERE run_id = $1 AND side = 'base'`, [run.id]);
    assert.deepEqual([base.density, base.dense_object_key], [1, null], 'a 1x still is one copy');
    // A density without its original, or an original at 1x, is refused.
    for (const [density, dense] of [[2, null], [1, DENSE]]) {
      await assert.rejects(pool.query(
        `UPDATE shot_artifacts SET density = $2, dense_object_key = $3 WHERE run_id = $1 AND side = 'base'`, [run.id, density, dense ? await fixtureKey(pool, dense) : null]),
      /shot_artifacts_density_check/);
    }
  });

  // Close-ups (services/shots-closeups.js) publish with their number,
  // region and density; two of one screen sit side by side.
  await t.test('S9c close-ups publish beside the stills, two of one screen apart by their number', async () => {
    defaults();
    const CLOSE = Buffer.from('fake-closeup');
    const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
    work.answer.set(WORK.agent, async (input) => {
      await saved(input.runId, 'base');
      await saved(input.runId, 'head');
      for (const part of [1, 2]) {
        await pool.query(
          `INSERT INTO shot_run_files (run_id, slot, story_id, viewport, side, variant, media, content_type, object_key, width, height, bytes, sha256,
                                       part, scale, focus_rect)
           VALUES ($1, $2, 'c1', 'desktop', 'head', 'closeup', 'png', 'image/png', $3, 594, 360, $4, $5, $6, $7, $8::jsonb)`,
          [input.runId, `c1/desktop/head/closeup/${part}`, await fixtureKey(pool, CLOSE), CLOSE.length, sha(`c${part}`), part, part === 1 ? 9 : 8.2,
            JSON.stringify({ x: 40 * part, y: 30, w: 66, h: 40 })]);
      }
      return { ...passed(input), slots: [...passed(input).slots, 'c1/desktop/head/closeup/1', 'c1/desktop/head/closeup/2'] };
    });
    const s = await proposal();
    await declare(s);
    await rt.drain();
    await send(s, 'HeadReady', { head: SHA('a') }, fromPreview);
    await settle();
    const [run] = await runs(s);
    assert.equal(run.state, 'verified');
    const { rows } = await pool.query(
      `SELECT variant, part, scale::float AS scale, focus_rect FROM shot_artifacts WHERE run_id = $1 ORDER BY variant, side, part`, [run.id]);
    assert.deepEqual(rows.filter((r) => r.variant === 'closeup'), [
      { variant: 'closeup', part: 1, scale: 9, focus_rect: { x: 40, y: 30, w: 66, h: 40 } },
      { variant: 'closeup', part: 2, scale: 8.2, focus_rect: { x: 80, y: 30, w: 66, h: 40 } },
    ]);
    assert.ok(rows.filter((r) => r.variant !== 'closeup').every((r) => r.part === 0 && r.scale === null));
    // A close-up without its number or region, or a still with a number, is refused.
    for (const [variant, part, scale, rect] of [['closeup', 0, 9, '{}'], ['closeup', 1, null, '{}'], ['closeup', 1, 9, null], ['context', 1, null, null]]) {
      await assert.rejects(pool.query(
        `INSERT INTO shot_artifacts (id, run_id, story_id, viewport, side, variant, media, content_type, object_key, bytes, sha256, part, scale, focus_rect)
         VALUES ($1, $2, 'c1', 'phone', 'head', $3, 'png', 'image/png', $8, 1, $4, $5, $6, $7::jsonb)`,
        [crypto.randomBytes(16).toString('hex'), run.id, variant, sha('x'), part, scale, rect, await fixtureKey(pool, Buffer.from([0]))]), /variant_closeup_check/, `${variant} ${part}`);
    }
  });

  await t.test('S2 a declaration on a head already ready starts at once; the same one again changes nothing', async () => {
    defaults();
    const s = await proposal({ ready: true });
    const id = await declare(s);
    await settle();
    assert.equal((await outcome(id)).result, 'accepted');
    assert.equal((await instance(s)).state, 'published');
    const before = work.calls.length;
    const again = await declare(s);
    await settle();
    assert.equal(work.calls.length, before, 'no new run');
    const { rows: [answer] } = await pool.query('SELECT reply FROM wf_events WHERE id = $1', [again]);
    assert.equal(answer.reply.unchanged, true, 'the declaring route hears it changed nothing');
    assert.equal(answer.reply.state, 'verified');
  });

  await t.test('S3 nothing visible declared: not needed, and the bot hears it settled', async () => {
    defaults();
    const s = await proposal({ ready: true });
    await declare(s, INTENT('none'));
    await settle();
    assert.equal((await instance(s)).state, 'not_needed');
    assert.equal((await row(s)).shots_state, 'not_required');
    assert.equal(calls(WORK.revision).length, 0);
    assert.equal(await settledTold(s), 1);
    assert.equal(calls('bot.shotsSettled').length, 0, 'by message, not work');
  });

  await t.test('S4 the proposal\'s agent busy: the run waits, and goes on once it is free', async () => {
    defaults();
    const s = await proposal();
    await declare(s);
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"mode":"build"}'::jsonb WHERE id = $1`, [s.id]);
    await send(s, 'HeadReady', { head: SHA('a') }, fromPreview);
    await settle();
    let i = await instance(s);
    assert.equal(i.state, 'waiting_for_agent');
    assert.ok(i.deadline_at, 'it looks again on its timer');
    assert.equal(Date.parse(i.data.run.agentWaitUntil) - Date.parse(i.data.run.copiesAt), 1440000,
      'the agent is waited for from the moment the copies serve, not from the run\'s start');
    assert.equal((await row(s)).shots_state, 'exploring');
    await due(s);
    await rt.fireTimers();
    await settle();
    assert.equal((await instance(s)).state, 'waiting_for_agent', 'still busy');
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [s.id]);
    await due(s);
    await rt.fireTimers();
    await settle();
    i = await instance(s);
    assert.equal(i.state, 'published');
  });

  await t.test('S5 an agent that keeps another turn from it twice, then still: the run fails as busy', async () => {
    defaults();
    work.answer.set(WORK.agent, () => ({ agent: { outcome: 'busy', code: 'TURN_IN_FLIGHT', busy: true }, passed: false, skippedAny: false }));
    const s = await proposal({ ready: true });
    await declare(s);
    await settle();
    // Busy answers send it back to waiting; the facts say the agent is free
    // again on each recheck.
    for (let n = 0; n < 4; n++) {
      if ((await instance(s)).state !== 'waiting_for_agent') break;
      await due(s);
      await rt.fireTimers();
      await settle();
    }
    const i = await instance(s);
    assert.equal(i.state, 'failed');
    assert.equal(calls(WORK.agent).length, 3, 'the first dispatch and two more');
    const [run] = await runs(s);
    assert.equal(run.failure_code, 'TURN_IN_FLIGHT');
  });

  await t.test('S6 the agent\'s process died: dispatched once more; died again, the platform fault is taken again once', async () => {
    defaults();
    work.answer.set(WORK.agent, () => ({ agent: { outcome: 'died', code: 'shots_agent_failed', died: true, message: 'oom' },
      passed: false, skippedAny: false }));
    const s = await proposal({ ready: true });
    await declare(s);
    await settle();
    let i = await instance(s);
    assert.equal(i.state, 'failed');
    assert.equal(calls(WORK.agent).length, 2);
    let [run] = await runs(s);
    assert.equal(run.trace_summary.platformFault.kind, 'agent_exit');
    assert.equal((await row(s)).shots_detail.automaticRetryPending, true, 'the card says it is trying again');
    assert.ok(i.deadline_at);
    await due(s);
    await rt.fireTimers();
    await settle();
    i = await instance(s);
    assert.equal(i.state, 'failed', 'the retry failed the same way');
    const all = await runs(s);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((r) => [r.state, r.trigger]), [['stale', 'declared'], ['failed', 'platform-retry']]);
    assert.equal(i.deadline_at, null, 'no third run');
    assert.equal((await row(s)).shots_detail.automaticRetryPending, false);
    [run] = all.slice(-1);
    assert.equal(run.trace_summary.automaticRetry, undefined);
  });

  await t.test('S7 a new head while the agent works: the run is cancelled, its turn and copies go, the new head waits', async () => {
    defaults();
    const s = await proposal({ ready: true });
    let state = null;
    // The head moves while the agent's step runs: its result is refused.
    work.answer.set(WORK.agent, async (input) => {
      state = (await instance(s)).state;
      await send(s, 'HeadMoved', { head: SHA('b') });
      return passed(input);
    });
    await declare(s);
    await settle();
    assert.equal(state, 'taking_shots');
    assert.equal((await instance(s)).state, 'waiting_for_preview');
    const r = await row(s);
    assert.deepEqual([r.shots_state, r.shots_run_id, r.shots_detail.headSha], ['planned', null, SHA('b')]);
    const [run] = await runs(s);
    assert.deepEqual([run.state, run.failure_code], ['cancelled', 'superseded']);
    const cleanup = calls(WORK.cleanup).find((c) => c.input.runId === run.id);
    assert.equal(cleanup.input.stopTurn, true, 'the agent\'s turn is stopped');
    assert.equal(calls(WORK.publish).length, 0, 'the refused result published nothing');
  });

  await t.test('S8 Stop while the agent works, then a person\'s Retry; published shots are not waived', async () => {
    defaults();
    const s = await proposal({ ready: true });
    work.answer.set(WORK.agent, async (input) => {
      await send(s, 'StopRequested', {}, route);
      return passed(input);
    });
    await declare(s);
    await settle();
    assert.equal((await instance(s)).state, 'failed');
    let [run] = await runs(s);
    assert.equal(run.failure_code, 'shots_stopped');
    assert.equal((await row(s)).shots_detail.automaticRetryPending, false, 'a stop is not taken again on its own');
    const again = await send(s, 'StopRequested', {}, route);
    await rt.drain();
    assert.deepEqual([(await outcome(again)).result, (await outcome(again)).reason], ['rejected', 'not_running']);
    defaults();
    await send(s, 'RetryRequested', {}, route);
    await settle();
    assert.equal((await instance(s)).state, 'published');
    run = (await runs(s)).slice(-1)[0];
    assert.equal(run.trigger, 'manual-rerun');
    const waived = await send(s, 'WaiveRequested', { userId: s.user_id, reason: 'Visible on staging' }, route);
    await rt.drain();
    assert.deepEqual([(await outcome(waived)).result, (await outcome(waived)).reason], ['rejected', 'invalid_shots_override_state'],
      'published shots are not waived');
  });

  await t.test('S9 a failed run is waived by an admin; the slot reads overridden', async () => {
    defaults();
    work.answer.set(WORK.copies, () => ({ failed: { code: 'shots_build_failed', message: 'The after build failed.', fault: null } }));
    const s = await proposal({ ready: true });
    await declare(s);
    await settle();
    assert.equal((await instance(s)).state, 'failed');
    assert.equal((await instance(s)).deadline_at, null, 'the proposal\'s own fault is not taken again');
    const admin = await user();
    await send(s, 'WaiveRequested', { userId: admin.id, reason: 'Checked by hand' }, route);
    await settle();
    assert.equal((await instance(s)).state, 'waived');
    const r = await row(s);
    assert.equal(r.shots_state, 'overridden');
    assert.equal(r.shots_detail.overrideReason, 'Checked by hand');
  });

  await t.test('S10 the proposal closes while the run builds: it ends, its copies and temporary worker go', async () => {
    defaults();
    const s = await proposal({ ready: true, source: 'imported' });
    work.answer.set(WORK.copies, async () => {
      await send(s, 'Closed', { reason: 'archived' }, fromPreview);
      return { fixtureFingerprint: 'fp', baseImageDigest: 'b', headImageDigest: 'h' };
    });
    await declare(s);
    await settle();
    assert.equal((await instance(s)).state, 'closed');
    const [run] = await runs(s);
    assert.equal(run.failure_code, 'shots_closed');
    const cleanup = calls(WORK.cleanup).find((c) => c.input.runId === run.id);
    assert.equal(cleanup.input.worker, true, 'an imported proposal\'s temporary worker goes');
    assert.equal(calls(WORK.agent).length, 0);
  });

  // 21 Oct 2026: a merge no longer waits for the shots (PR 5787 waited for
  // them, declined busy), so a proposal may merge while they are taken.
  await t.test('S10b the proposal merges while its shots are taken: the run goes on and publishes, then its copies go', async () => {
    defaults();
    const s = await proposal({ ready: true });
    work.answer.set(WORK.agent, async (input) => {
      await send(s, 'Closed', { reason: 'merged' }, fromPreview);
      return passed(input);
    });
    await declare(s);
    await settle();
    assert.equal((await instance(s)).state, 'published', 'the merged head\'s pictures stand');
    const [run] = await runs(s);
    assert.equal(run.failure_code, null);
    assert.ok(calls(WORK.cleanup).some((c) => c.input.runId === run.id), 'its copies go once it ends');
  });

  await t.test('S11 the platform\'s refusals are said on the slot: a revision GitHub cannot compare', async () => {
    defaults();
    work.answer.set(WORK.revision, () => ({ failed: { code: 'missing_shots_base', message: 'no merge base' } }));
    const s = await proposal({ ready: true });
    await declare(s);
    await settle();
    assert.equal((await instance(s)).state, 'waiting_for_preview');
    const r = await row(s);
    assert.equal(r.shots_state, 'planned');
    assert.match(r.shots_detail.notStartedReason, /could not be resolved/);
    assert.equal((await runs(s)).length, 0, 'no run row was made');
  });

  await t.test('S12 a deployment that takes no shots says so', async () => {
    const off = shots({ execute: false, agentBudgetMs: 480000, runBudgetMs: 1440000 });
    const rt2 = createRuntime({ pool, machines: [off], pollMs: 50, publish: async () => {} });
    runtimes.push(rt2);
    const s = await proposal({ ready: true });
    await rt2.append(off, sessionKey(s.id), { type: 'Declared', payload: { sessionId: s.id, intent: INTENT() } },
      { requestKey: `t-${++rk}`, source: route, appId: s.app_id });
    await rt2.drain();
    assert.match((await row(s)).shots_detail.notStartedReason, /not being taken on this deployment/);
  });

  await t.test('S13 a UI change with no declaration: the slot says one is needed; a declaration then stands', async () => {
    defaults();
    const s = await proposal();
    await send(s, 'UiUndeclared', { head: SHA('a') }, fromPreview);
    await rt.drain();
    let r = await row(s);
    assert.equal((await instance(s)).state, 'undeclared');
    assert.deepEqual([r.shots_state, r.shots_detail.required, r.shots_detail.claims], ['planned', true, []]);
    await send(s, 'HeadReady', { head: SHA('a') }, fromPreview);
    await rt.drain();
    assert.match((await row(s)).shots_detail.notStartedReason, /no declared change/);
    await declare(s);
    await rt.drain();
    r = await row(s);
    assert.equal(r.shots_detail.claims.length, 1);
    await send(s, 'UiUndeclared', { head: SHA('a') }, fromPreview);
    await rt.drain();
    assert.equal((await row(s)).shots_detail.claims.length, 1, 'a declaration stands');
  });

  await t.test('S14 a run [main] was taking is adopted as interrupted, cleaned up, and taken again at the release', async () => {
    defaults();
    const s = await proposal({ ready: true });
    const oldRun = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO shot_runs (id, session_id, base_sha, head_sha, intent, state, trigger)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'exploring', 'preview-ready')`, [oldRun, s.id, SHA('0'), SHA('a'), JSON.stringify(INTENT())]);
    await pool.query(
      `UPDATE chat_sessions SET shots_state = 'exploring', shots_run_id = $2, shots_detail = $3::jsonb WHERE id = $1`,
      [s.id, oldRun, JSON.stringify({ state: 'exploring', headSha: SHA('a'), intent: INTENT() })]);
    await send(s, 'RetryRequested', { reason: 'release' }, { kind: 'system', name: 'release' });
    await settle();
    assert.equal((await instance(s)).state, 'published');
    const all = await runs(s);
    assert.equal(all[0].id, oldRun);
    assert.equal(all[0].failure_code, 'shots_run_interrupted');
    assert.equal(all[0].state, 'stale');
    assert.equal(all[1].trigger, 'release-retry');
    assert.ok(calls(WORK.cleanup).some((c) => c.input.runId === oldRun && c.input.stopTurn), 'the interrupted run\'s copies go');
  });

  await t.test('S15 the copies take too long: the run fails, and is taken again once', async () => {
    defaults();
    const s = await proposal({ ready: true });
    let first = true;
    work.answer.set(WORK.copies, async (input) => {
      if (first) {
        first = false;
        await due(s);
        await rt.fireTimers();
        return { fixtureFingerprint: 'fp', baseImageDigest: 'b', headImageDigest: 'h' };
      }
      await workspace(input.runId, input.sessionId);
      return { fixtureFingerprint: 'fp', baseImageDigest: 'b', headImageDigest: 'h' };
    });
    await declare(s);
    await settle();
    let i = await instance(s);
    assert.equal(i.state, 'failed');
    assert.equal((await runs(s))[0].failure_code, 'shots_copies_timeout');
    assert.ok(i.deadline_at, 'taken again once');
    await due(s);
    await rt.fireTimers();
    await settle();
    i = await instance(s);
    assert.equal(i.state, 'published');
  });

  await t.test('S16 the slot and the runs are the machine\'s: a write from outside it is refused', async () => {
    defaults();
    const s = await proposal({ ready: true });
    await declare(s);
    await settle();
    await assert.rejects(pool.query(`UPDATE chat_sessions SET shots_state = 'failed' WHERE id = $1`, [s.id]), /WF_OWNERSHIP_VIOLATION/);
    await assert.rejects(pool.query(`UPDATE shot_runs SET state = 'failed' WHERE session_id = $1`, [s.id]), /WF_OWNERSHIP_VIOLATION/);
    await assert.rejects(pool.query(
      `INSERT INTO shot_runs (id, session_id, base_sha, head_sha, intent, state) VALUES ($1, $2, $3, $3, '{}'::jsonb, 'planned')`,
      [crypto.randomBytes(16).toString('hex'), s.id, SHA('c')]), /WF_OWNERSHIP_VIOLATION/);
    // A proposal the machine does not hold is anyone's (a seed).
    const other = await proposal();
    await pool.query(`UPDATE chat_sessions SET shots_state = 'verified' WHERE id = $1`, [other.id]);
    // Retention deletes are not refused.
    await pool.query(`DELETE FROM shot_runs WHERE session_id = $1`, [s.id]).catch((err) => assert.match(err.message, /foreign key/));
  });

  await t.test('S17 an imported proposal\'s preview will not start: the slot says why', async () => {
    defaults();
    const s = await proposal({ source: 'imported' });
    await declare(s);
    await send(s, 'PreviewStopped', { head: SHA('a') }, fromPreview);
    await rt.drain();
    assert.match((await row(s)).shots_detail.notStartedReason, /No staging preview was built/);
  });

  await t.test('S18 a closed proposal starts no automatic run; a person may take a merged one\'s again, and nothing to shoot settles at once', async () => {
    defaults();
    const s = await proposal({ status: 'merged' });
    await declare(s);
    await send(s, 'HeadReady', { head: SHA('a') }, fromPreview);
    await settle();
    assert.equal(calls(WORK.revision).length, 0, 'no automatic run on a merged change');
    const system = await send(s, 'RetryRequested', {}, { kind: 'system' });
    await rt.drain();
    assert.deepEqual([(await outcome(system)).result, (await outcome(system)).reason], ['rejected', 'closed']);
    await send(s, 'RetryRequested', {}, route);
    await settle();
    assert.equal((await instance(s)).state, 'published', 'a person\'s rerun to diagnose an old failure');
    // A retry with a declaration that shows nothing: not needed, and GitHub
    // is not asked.
    const before = calls(WORK.revision).length;
    await send(s, 'RetryRequested', { intent: INTENT('none') }, route);
    await settle();
    assert.equal((await instance(s)).state, 'not_needed');
    assert.equal((await row(s)).shots_state, 'not_required');
    assert.equal(calls(WORK.revision).length, before);
  });

  await t.test('S19 a declaration appended in its caller\'s transaction applies once it commits; a changed one cancels the run under way', async () => {
    defaults();
    const s = await proposal();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await rt.append(machine, sessionKey(s.id), { type: 'Declared', payload: { sessionId: s.id, intent: INTENT() } },
        { requestKey: `t-${++rk}`, source: route, appId: s.app_id, db: c });
      await c.query('ROLLBACK');
    } finally { c.release(); }
    await rt.drain();
    assert.equal(await instance(s), undefined, 'rolled back: nothing was declared');
    const c2 = await pool.connect();
    try {
      await c2.query('BEGIN');
      await rt.append(machine, sessionKey(s.id), { type: 'Declared', payload: { sessionId: s.id, intent: INTENT() } },
        { requestKey: `t-${++rk}`, source: route, appId: s.app_id, db: c2 });
      await c2.query('COMMIT');
    } finally { c2.release(); }
    await rt.drain();
    assert.equal((await row(s)).shots_detail.claims.length, 1);
    // A run under way, then a changed declaration.
    work.answer.set(WORK.agent, async (input) => {
      await declare(s, INTENT('ui', 'The card shows the old badge too'));
      return passed(input);
    });
    await send(s, 'HeadReady', { head: SHA('a') }, fromPreview);
    await settle();
    const [run] = await runs(s);
    assert.deepEqual([run.state, run.failure_code], ['cancelled', 'intent_changed']);
    assert.equal((await row(s)).shots_detail.claims[0].claim, 'The card shows the old badge too');
  });

  await t.test('S20 a step past its deadline: a stuck agent fails the run (taken again once), a stuck comparison publishes without outlines', async () => {
    defaults();
    const s = await proposal({ ready: true });
    let first = true;
    work.answer.set(WORK.agent, async (input) => {
      if (first) {
        first = false;
        await due(s);
        await rt.fireTimers();
        return passed(input);   // a result after it was given up on: refused
      }
      await saved(input.runId, 'base');
      await saved(input.runId, 'head');
      return passed(input);
    });
    await declare(s);
    await settle();
    let i = await instance(s);
    assert.equal(i.state, 'failed');
    const [run] = await runs(s);
    assert.equal(run.failure_code, 'shots_agent_timeout');
    assert.equal(run.trace_summary.platformFault.kind, 'agent_exit');
    assert.equal(calls(WORK.publish).length, 0);
    // The one retry; its comparison never ends.
    work.answer.set(WORK.publish, async () => {
      await due(s);
      await rt.fireTimers();
      return { verdict: { screens: ['too late'] } };
    });
    await due(s);
    await rt.fireTimers();
    await settle();
    i = await instance(s);
    assert.equal(i.state, 'published');
    const last = (await runs(s)).slice(-1)[0];
    assert.equal(last.state, 'verified');
    assert.equal(last.hard_verdict.screens, undefined, 'published as the agent left it, without outlines');
  });

  await t.test('S21 nothing on the slot yet (its revision is being resolved): Stop and waive have nothing to act on', async () => {
    defaults();
    const s = await proposal({ ready: true });
    let stop = null;
    work.answer.set(WORK.revision, async () => {
      stop = await send(s, 'StopRequested', {}, route);
      return { baseSha: SHA('0') };
    });
    await declare(s);
    await settle();
    assert.deepEqual([(await outcome(stop)).result, (await outcome(stop)).reason], ['rejected', 'not_running']);
    assert.equal((await instance(s)).state, 'published');
  });

  const workRow = async (s, key) => (await pool.query(
    'SELECT status, result FROM wf_work WHERE machine = $1 AND key = $2 AND work_key = $3', [MACHINE, sessionKey(s.id), key])).rows[0];

  await t.test('S22 a run that ends while its copies build: they are left to finish, and only then cleaned up', async () => {
    defaults();
    const s = await proposal({ ready: true });
    let during = null;
    work.answer.set(WORK.copies, async (input) => {
      await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, SHA('b')]);
      await send(s, 'HeadMoved', { head: SHA('b') });
      await rt.drain();
      during = { copies: await workRow(s, `copies:${(await instance(s)).data.n}`), cleanups: (await workOf(s, WORK.cleanup)).length,
        cleaning: (await instance(s)).data.cleaning };
      return { stale: true };
    });
    await declare(s);
    await settle();
    assert.equal(during.copies.status, 'running', 'the copies step is not cancelled under the copies it makes');
    assert.equal(during.cleanups, 0, 'no cleanup while they are still being built');
    assert.equal(during.cleaning[0].awaitCopies, true);
    const [run] = await runs(s);
    assert.deepEqual([run.state, run.failure_code], ['cancelled', 'superseded']);
    assert.ok(calls(WORK.cleanup).some((c) => c.input.runId === run.id), 'cleaned up once the copies reported');
    assert.deepEqual((await instance(s)).data.cleaning, [], 'and done');
    assert.equal((await instance(s)).state, 'waiting_for_preview');
  });

  await t.test('S23 a proposal back in review on the same head is shot again; settled shots stand through a close', async () => {
    defaults();
    const s = await proposal({ ready: true });
    work.answer.set(WORK.agent, async (input) => {
      await send(s, 'Closed', { reason: 'archived' }, fromPreview);
      return passed(input);
    });
    await declare(s);
    await settle();
    assert.equal((await instance(s)).state, 'closed');
    defaults();
    await send(s, 'HeadReady', { head: SHA('a') }, fromPreview);
    await settle();
    assert.equal((await instance(s)).state, 'published', 'unarchived: its preview ready again on the same head');
    await send(s, 'Closed', { reason: 'merged' }, fromPreview);
    await rt.drain();
    assert.equal((await instance(s)).state, 'published', 'published shots are not undone by a close');
  });

  // A run [main] was taking on the proposal, as its row shows it.
  async function mainRun(s, state = 'exploring', failureCode = null) {
    const id = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO shot_runs (id, session_id, base_sha, head_sha, intent, state, trigger, failure_code, completed_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::text, 'preview-ready', $7, CASE WHEN $6::text = 'failed' THEN NOW() END)`,
      [id, s.id, SHA('0'), SHA('a'), JSON.stringify(INTENT()), state, failureCode]);
    await pool.query(
      `UPDATE chat_sessions SET shots_state = $3, shots_run_id = $2, shots_detail = $4::jsonb WHERE id = $1`,
      [s.id, id, state, JSON.stringify({ state, headSha: SHA('a'), intent: INTENT() })]);
    return id;
  }

  await t.test('S24 a run the release cut off, adopted by any event, is taken again once; a closed proposal\'s is only cleaned up', async () => {
    defaults();
    const s = await proposal({ ready: true });
    const oldRun = await mainRun(s);
    await send(s, 'HeadReady', { head: SHA('a') }, fromPreview);
    await settle();
    let i = await instance(s);
    assert.equal(i.state, 'failed');
    assert.equal(i.deadline_event.type, 'RetryDue', 'taken again once, as a platform fault is');
    assert.equal((await runs(s))[0].failure_code, 'shots_run_interrupted');
    assert.ok(calls(WORK.cleanup).some((c) => c.input.runId === oldRun));
    await due(s);
    await rt.fireTimers();
    await settle();
    i = await instance(s);
    assert.equal(i.state, 'published');
    assert.equal((await runs(s)).slice(-1)[0].trigger, 'platform-retry');
    // One [main]'s shutdown marked interrupted is taken again too.
    const marked = await proposal({ ready: true });
    await mainRun(marked, 'failed', 'shots_run_interrupted');
    await send(marked, 'HeadReady', { head: SHA('a') }, fromPreview);
    await settle();
    assert.equal((await instance(marked)).deadline_event?.type, 'RetryDue');
    // A proposal that left review: its first event is its close.
    const gone = await proposal({ status: 'archived' });
    const goneRun = await mainRun(gone);
    await send(gone, 'Closed', { reason: 'archived' }, fromPreview);
    await settle();
    i = await instance(gone);
    assert.equal(i.state, 'failed');
    assert.equal(i.deadline_at, null, 'not taken again out of review');
    assert.ok(calls(WORK.cleanup).some((c) => c.input.runId === goneRun), 'its copies go');
  });

  await t.test('S25 a timer that fired for another run or step is ignored', async () => {
    defaults();
    const s = await proposal({ ready: true });
    const answers = [];
    work.answer.set(WORK.agent, async (input) => {
      const timer = { kind: 'timer' };
      for (const payload of [{ runId: input.runId, phase: 'copies' }, { runId: 'f'.repeat(32), phase: 'agent:1' }, {}]) {
        const id = await send(s, 'Overdue', payload, timer);
        await rt.drain();
        answers.push((await outcome(id)).reason);
      }
      await saved(input.runId, 'base');
      await saved(input.runId, 'head');
      return passed(input);
    });
    await declare(s);
    await settle();
    assert.deepEqual(answers, ['nothing_due', 'nothing_due', 'nothing_due']);
    assert.equal((await instance(s)).state, 'published');
  });

  await t.test('S26 GitHub\'s limit while resolving the revision: the run never started, and is taken again once the limit resets', async () => {
    defaults();
    let first = true;
    work.answer.set(WORK.revision, () => {
      if (!first) return { baseSha: SHA('0') };
      first = false;
      return { failed: { code: 'github_rate_limited', message: 'GitHub rate limit', fault: 'github_rate_limited',
        retryAt: new Date(Date.now() + 5000).toISOString() } };
    });
    const s = await proposal({ ready: true });
    await declare(s);
    await settle();
    let i = await instance(s);
    assert.equal(i.state, 'waiting_for_preview');
    assert.match((await row(s)).shots_detail.notStartedReason, /could not be resolved/);
    assert.equal(i.deadline_event.type, 'RetryDue');
    assert.equal((await runs(s)).length, 0);
    const waive = await send(s, 'WaiveRequested', { userId: s.user_id, reason: 'x' }, route);
    await rt.drain();
    assert.equal((await outcome(waive)).reason, 'invalid_shots_override_state', 'no run on the slot to waive');
    await due(s);
    await rt.fireTimers();
    await settle();
    i = await instance(s);
    assert.equal(i.state, 'published');
  });

  await t.test('S27 a run past its deadline before it had a row: not started (taken again), never a failed run with nothing behind it', async () => {
    defaults();
    const s = await proposal({ ready: true });
    let first = true;
    work.answer.set(WORK.revision, async () => {
      if (first) { first = false; await due(s); await rt.fireTimers(); }
      return { baseSha: SHA('0') };
    });
    await declare(s);
    await settle();
    let i = await instance(s);
    assert.equal(i.state, 'waiting_for_preview');
    assert.equal(i.data.last.row, false);
    assert.equal((await runs(s)).length, 0, 'the late revision was refused: no row');
    await due(s);
    await rt.fireTimers();
    await settle();
    i = await instance(s);
    assert.equal(i.state, 'published');
  });

  await t.test('S28 a ready message for a head the proposal moved past is ignored', async () => {
    defaults();
    const s = await proposal();
    await declare(s);
    await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, SHA('b')]);
    await send(s, 'HeadMoved', { head: SHA('b') });
    await send(s, 'HeadReady', { head: SHA('a') }, fromPreview);
    await settle();
    const i = await instance(s);
    assert.deepEqual([i.state, i.data.head], ['waiting_for_preview', SHA('b')]);
    assert.equal(calls(WORK.revision).length, 0);
  });

  await t.test('S29 the same refusal is told once; a person\'s Retry answers with the run it starts, not the last one', async () => {
    defaults();
    const s = await proposal();
    await send(s, 'UiUndeclared', { head: SHA('a') }, fromPreview);
    for (let n = 0; n < 3; n++) await send(s, 'HeadReady', { head: SHA('a') }, fromPreview);
    await settle();
    assert.equal(await settledTold(s), 1, 'no declaration: said once');
    work.answer.set(WORK.copies, () => ({ failed: { code: 'shots_build_failed', message: 'The after build failed.', fault: null } }));
    await declare(s);
    await send(s, 'HeadReady', { head: SHA('a') }, fromPreview);
    await settle();
    assert.equal((await instance(s)).state, 'failed');
    defaults();
    let reply = null;
    work.answer.set(WORK.revision, async () => {
      const { rows: [e] } = await pool.query(
        `SELECT reply FROM wf_events WHERE machine = $1 AND key = $2 AND type = 'RetryRequested' ORDER BY id DESC LIMIT 1`,
        [MACHINE, sessionKey(s.id)]);
      reply = e.reply;
      return { baseSha: SHA('0') };
    });
    await send(s, 'RetryRequested', {}, route);
    await settle();
    assert.deepEqual([reply.state, reply.runId], ['planned', null]);
  });

  await t.test('S30 the agent\'s own fault kinds are read, and a refused tool call is kept in the run\'s trace', async () => {
    defaults();
    work.answer.set(WORK.agent, () => ({ agent: { outcome: 'failed', code: 'shots_worker_bootstrap', message: 'The worker did not start.',
      fault: 'worker_bootstrap' }, passed: false, skippedAny: false }));
    const s = await proposal({ ready: true });
    await declare(s);
    await settle();
    const i = await instance(s);
    assert.equal(i.state, 'failed');
    assert.equal(i.deadline_event.type, 'RetryDue', 'a worker that did not start is the platform\'s fault');
    const other = await proposal({ ready: true });
    work.answer.set(WORK.agent, () => ({ agent: { outcome: 'completed' }, passed: false, skippedAny: true, failedCount: 0,
      incompleteReason: 'Nothing was saved.', lastToolFailure: { tool: 'save_shot', toolCode: 'shots_slot_invalid', toolMessage: 'No such screen.' } }));
    await declare(other);
    await settle();
    const [run] = await runs(other);
    assert.equal(run.failure_code, 'shots_capture_incomplete');
    assert.deepEqual(run.trace_summary.lastToolFailure, { tool: 'save_shot', toolCode: 'shots_slot_invalid', toolMessage: 'No such screen.' });
    // A deleted account's waiver loses its name without the run moving.
    await pool.query('UPDATE shot_runs SET override_user_id = NULL WHERE id = $1', [run.id]);
  });

  await t.test('S32 a head move or declaration a newer move overtook is refused, and the newer head\'s shots stand', async () => {
    defaults();
    // An imported proposal: two import passes, A then B. B's pass wrote its
    // head and appended first; A's pass, which wrote A before, appends last.
    const s = await proposal({ source: 'imported', head: SHA('b'), ready: true });
    await declare(s, INTENT(), SHA('b'));
    await settle();
    assert.equal((await instance(s)).state, 'published');
    const [published] = await runs(s);
    const late = await send(s, 'HeadMoved', { head: SHA('a'), pin: 'imported' });
    const lateDeclared = await send(s, 'Declared', { head: SHA('a'), intent: INTENT('ui', 'An older claim'), pin: 'imported' }, route);
    await settle();
    for (const id of [late, lateDeclared]) {
      assert.deepEqual([(await outcome(id)).result, (await outcome(id)).reason], ['rejected', 'stale_head']);
    }
    const i = await instance(s);
    assert.deepEqual([i.state, i.data.head], ['published', SHA('b')]);
    const r = await row(s);
    assert.deepEqual([r.shots_state, r.shots_run_id], ['verified', published.id], 'the newer head\'s shots stand');
    assert.equal((await runs(s))[0].state, 'verified');
    // A Retry still takes the current head.
    await send(s, 'RetryRequested', {}, route);
    await settle();
    assert.equal((await runs(s)).slice(-1)[0].head_sha, SHA('b'));
    // A caller that appends before it writes names the head it replaced: its
    // move stands while the column still holds that head, and once it holds
    // the new one.
    const before = await send(s, 'HeadMoved', { head: SHA('c'), pin: 'imported', from: SHA('b') });
    await settle();
    assert.equal((await outcome(before)).result, 'accepted');
    assert.equal((await instance(s)).data.head, SHA('c'));
    // Moved back by a force-push: the column holds it again, so it is not stale.
    await pool.query('UPDATE chat_sessions SET imported_pr_head_sha = $2 WHERE id = $1', [s.id, SHA('b')]);
    const back = await send(s, 'HeadMoved', { head: SHA('b'), pin: 'imported' });
    await settle();
    assert.equal((await outcome(back)).result, 'accepted');
    assert.equal((await instance(s)).data.head, SHA('b'));
  });

  await t.test('S33 a same-head resubmission read before an import moved the proposal does not take its shots back', async () => {
    defaults();
    const shotsState = require('../src/services/shots-state');
    const proposalUpdate = require('../src/services/proposal-update');
    // The declaring wrappers, against this runtime.
    shotsState._setWorkflowForTests({
      async shotsDeclared(d) {
        const id = await rt.append(machine, sessionKey(d.sessionId),
          { type: 'Declared', payload: { sessionId: d.sessionId, head: d.head, intent: d.intent, pin: d.pin, from: d.from } },
          { requestKey: `t-${++rk}`, source: route, appId: d.appId });
        await settle();
        const { rows: [e] } = await pool.query('SELECT result, reason, reply FROM wf_events WHERE id = $1', [id]);
        return { status: e.result, reason: e.reason, reply: e.reply };
      },
    });
    t.after(() => shotsState._setWorkflowForTests(null));
    const s = await proposal({ source: 'imported', head: SHA('b'), ready: true });
    await declare(s, INTENT(), SHA('b'));
    await settle();
    const [published] = await runs(s);
    assert.equal(published.state, 'verified');
    // The resubmit read the row while it still said A.
    const read = { ...(await row(s)), imported_pr_head_sha: SHA('a') };
    const result = await proposalUpdate.applyShotsRevision({
      pool, config: { shots: { collect: true } }, session: read, headSha: SHA('a'),
      visibleChanges: INTENT('ui', 'An older claim'), pin: 'imported', from: read.imported_pr_head_sha,
    });
    assert.equal(result.accepted, false, 'refused: a newer revision replaced it');
    const i = await instance(s);
    assert.deepEqual([i.state, i.data.head], ['published', SHA('b')]);
    assert.deepEqual([(await row(s)).shots_state, (await runs(s))[0].state], ['verified', 'verified']);
  });
});
