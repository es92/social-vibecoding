'use strict';

// The merge (step 6) against the full PostgreSQL schema: the app's merge
// queue (src/workflow/merge-queue/) and the proposal machine's attempt, its
// `unconfirmed` state, its syncs with main and an admin's force
// (src/workflow/proposal/). The work is fake; the real handlers are
// src/workflow/proposal/services.ts (routes/votes.js evaluateMergeGate and
// attemptMerge, services/sync-main.js runSyncWork). Each [main] bug the step
// fixes (workflow-foundation's trace-merge.md §8) is named where it is
// pinned.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/workflow-merge-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { proposal, sessionKey, MACHINE, WORK, CLAIM_STALE_MS, REFUSAL_RETRY_MS } = require('../src/workflow/proposal/machine.ts');
const { inspect } = require('../src/workflow/kernel/index.ts');
const { attentionStates } = require('../src/workflow/platform.ts');
const { mergeQueue, MACHINE: QUEUE, appKey, SWEEP_MS } = require('../src/workflow/merge-queue/machine.ts');
const { preview } = require('../src/workflow/preview/machine.ts');
const { PROCESS_PRESENCE_LOCK } = require('../src/workflow/rules/presence.ts');
const { waitFor } = require('./lib/wait-for');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);
const DAY = 24 * 60 * 60 * 1000;
const DEPS = { idleMs: 0, exemptFixtures: false, reviewCheckMs: 60 * 60 * 1000, staleNotifyMs: 0, staleGraceMs: 0, shotsEnforced: false };

test('the merge against the full PostgreSQL schema', { timeout: 240000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_merge_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 12 });
  pool.on('error', () => {});
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:${MACHINE}', '1'), ('enabled:merge-followups', '1'),
                    ('enabled:${QUEUE}', '1') ON CONFLICT DO NOTHING`);

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  async function user() {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [`mg_${++seq}`]);
    return u;
  }
  async function app(owner, { approvalsRequired = 1, locked = false } = {}) {
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, repo_url, approvals_required, locked)
       VALUES ($1::text, $1::text, $2, 'https://github.com/acme/' || $1::text, $3, $4) RETURNING *`,
      [`mg-app-${++seq}`, owner.id, approvalsRequired, locked]);
    return a;
  }
  // A proposal in review, its checks passed on its head, measured clean.
  async function proposalRow({ appRow = null, owner = null, head = SHA('a'), checks = 'passing', clean = true,
    status = 'promoted', approvalsRequired = 1, source = null } = {}) {
    const o = owner || await user();
    const a = appRow || await app(o, { approvalsRequired });
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, source, branch_name, pr_number, pr_title, reviewed_head_sha,
                                  imported_pr_head_sha, promoted_at, check_state, checks_commit_sha,
                                  integration_merges_clean, integration_head_sha, integration_main_sha)
       VALUES ($1, $2, $3, $4, $12, $5, 'Make it better', $6, $7, NOW() - interval '1 day', $8, $9, $10, $9, $11)
       RETURNING *`,
      [a.id, o.id, status, source, ++seq, source === 'imported' ? null : head, source === 'imported' ? head : null,
        checks, head, clean, SHA('e'), `feature-${seq}`]);
    return { ...s, app: a, owner: o };
  }
  const row = async (s) => (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [s.id])).rows[0];
  const inst = async (machine, key) => (await pool.query(
    'SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [machine, key])).rows[0];
  const pInst = (s) => inst(MACHINE, sessionKey(s.id));
  const qInst = (a) => inst(QUEUE, appKey(a.id));
  const sentTo = async (machine, key) => (await pool.query(
    `SELECT type, payload, source FROM wf_events WHERE machine = $1 AND key = $2 AND source->>'kind' = 'message' ORDER BY id`,
    [machine, key])).rows;
  const lines = async (s) => (await pool.query(
    `SELECT content FROM chat_messages WHERE thread_type = 'session' AND thread_ref = $1 ORDER BY id`, [s.id])).rows.map((r) => r.content);
  const asTransition = async (fn) => {
    const c = await pool.connect();
    try { await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`); await fn(c); await c.query('COMMIT'); } finally { c.release(); }
  };
  const vote = (s, u, v) => pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, head_sha, approval_epoch)
     SELECT $1, $2, $3, cs.reviewed_head_sha, cs.approval_epoch FROM chat_sessions cs WHERE cs.id = $1
     ON CONFLICT (session_id, user_id) DO UPDATE SET vote = EXCLUDED.vote, approval_epoch = EXCLUDED.approval_epoch`,
    [s.id, u.id, v]);

  // Fake work: each call recorded; `answer` per kind (a value, or a function
  // of the input, which may throw); `hold` keeps an item running.
  const work = { calls: [], answer: new Map(), hold: new Map() };
  const fake = (kind, extra = {}) => ({
    maxAttempts: 1, backoffMs: () => 0, leaseMs: 600, ...extra,
    async run({ input, key }) {
      work.calls.push({ kind, key, input });
      if (work.hold.has(kind)) await work.hold.get(kind);
      const a = work.answer.get(kind);
      return typeof a === 'function' ? await a(input) : (a ?? { ok: true });
    },
  });
  const ready = (s, extra = {}) => ({ ready: true, head: s.reviewed_head_sha || s.imported_pr_head_sha, epoch: 0,
    explicitApproval: false, explicitReason: null, mainPassThrough: false, tally: { yes: 1, required: 1, active: 1 }, ...extra });
  const defaults = () => {
    work.calls.length = 0;
    work.hold.clear();
    work.answer.clear();
    work.answer.set(WORK.gate, async (input) => {
      const { rows: [r] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [input.sessionId]);
      return ready(r, { epoch: Number(r.approval_epoch) });
    });
    work.answer.set(WORK.attempt, { outcome: 'merged', sha: SHA('9') });
    work.answer.set(WORK.observe, { merged: true, sha: SHA('9'), mergedAt: new Date().toISOString() });
    work.answer.set(WORK.sync, { outcome: 'clean', sha: SHA('5'), message: 'Merged main cleanly.' });
  };
  defaults();
  const services = Object.fromEntries(Object.values(WORK).map((k) => [k, fake(k)]));
  // merge.attempt is tried a few times before GitHub's silence is read as
  // unknown, as the real handler is.
  services[WORK.attempt] = fake(WORK.attempt, { maxAttempts: 2 });
  const pm = proposal(DEPS);
  const qm = mergeQueue();
  const rt = createRuntime({ pool, machines: [pm, qm], pollMs: 50, publish: async () => {}, services });
  runtimes.push(rt);

  let rk = 0;
  const system = { kind: 'system' };
  const fromQueueSrc = { kind: 'message', from: { machine: QUEUE, key: 'x', eventId: 1 } };
  const toProposal = (s, type, payload = {}, source = system) => rt.append(pm, sessionKey(s.id),
    { type, payload: { sessionId: s.id, ...payload } }, { requestKey: `t-${++rk}`, source, appId: s.app_id });
  const want = (a, payload = {}) => rt.append(qm, appKey(a.id),
    { type: 'MergeWanted', payload: { appId: a.id, reason: 'test', ...payload } }, { requestKey: `w-${++rk}`, source: system, appId: a.id });
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  const outcome = async (id) => (await pool.query('SELECT result, reason, state_after, reply FROM wf_events WHERE id = $1', [id])).rows[0];
  const calls = (kind) => work.calls.filter((c) => c.kind === kind);
  const due = (machine, key) => asTransition((c) => c.query(
    'UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [machine, key]));
  const fire = async (machine, key) => { await due(machine, key); await rt.fireTimers(); await settle(); };

  // ── The direct lane ─────────────────────────────────────────────────

  await t.test('M1 a vote asks the queue: the gate is measured, the claim reads it again under the lock, GitHub is asked once, merge-followups is told', async () => {
    defaults();
    const s = await proposalRow();
    await vote(s, await user(), 'yes');
    await want(s.app, { sessionId: s.id });
    await settle();
    assert.equal(calls(WORK.gate).length, 1);
    assert.equal(calls(WORK.attempt).length, 1);
    assert.equal(calls(WORK.attempt)[0].input.head, SHA('a'), 'pinned to the head the claim was for');
    const i = await pInst(s);
    assert.equal(i.state, 'merging', 'merging until merge-followups moves it into merged');
    assert.equal((await row(s)).status, 'merging');
    const told = await sentTo('merge-followups', sessionKey(s.id));
    assert.equal(told.length, 1);
    assert.equal(told[0].type, 'Merged');
    assert.equal(told[0].payload.mergeSha, SHA('9'));
    assert.equal(told[0].payload.observedBy, 'merge');
    assert.deepEqual(told[0].payload.tally, { yes: 1, required: 1, active: 1 });
    const q = await qInst(s.app);
    assert.equal(q.state, 'idle', 'the queue moved on once the attempt ended');
    assert.equal(q.data.attempt, null);
  });

  await t.test('M2 the claim counts what changed since the gate: a No, a red main, a check that failed (bug 3)', async () => {
    defaults();
    const s = await proposalRow();
    const yes = await user();
    await vote(s, yes, 'yes');
    // The Yes taken back between the gate's measurement and the claim.
    work.answer.set(WORK.gate, async (input) => {
      await pool.query('DELETE FROM pr_votes WHERE session_id = $1 AND user_id = $2', [s.id, yes.id]);
      const { rows: [r] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [input.sessionId]);
      return ready(r);
    });
    await want(s.app, { sessionId: s.id });
    await settle();
    assert.equal(calls(WORK.attempt).length, 0, 'never asked GitHub');
    assert.equal((await pInst(s)).state, 'in_review');
    const ended = (await sentTo(QUEUE, appKey(s.app.id))).filter((e) => e.type === 'AttemptEnded');
    assert.equal(ended.at(-1).payload.reason, 'not_mergeable');

    defaults();
    const r = await proposalRow();
    await vote(r, await user(), 'yes');
    work.answer.set(WORK.gate, async (input) => {
      await pool.query(`UPDATE apps SET main_check_state = 'failing', main_check_sha = $2, main_check_paused_sha = $2 WHERE id = $1`,
        [r.app.id, SHA('b')]);
      const { rows: [x] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [input.sessionId]);
      return ready(x);
    });
    await want(r.app, { sessionId: r.id });
    await settle();
    assert.equal(calls(WORK.attempt).length, 0, 'main turned red: not merged past');
    assert.deepEqual([(await pInst(r)).state, (await row(r)).approval_epoch], ['in_review', 0], 'back to review with its votes (Q4)');
    assert.equal((await sentTo(QUEUE, appKey(r.app.id))).filter((e) => e.type === 'AttemptEnded').at(-1).payload.reason, 'main_failing');

    defaults();
    const c = await proposalRow();
    await vote(c, await user(), 'yes');
    work.answer.set(WORK.gate, async (input) => {
      await pool.query(`UPDATE chat_sessions SET check_state = 'failing' WHERE id = $1`, [c.id]);
      const { rows: [x] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [input.sessionId]);
      return ready(x);
    });
    await want(c.app, { sessionId: c.id });
    await settle();
    assert.equal(calls(WORK.attempt).length, 0);
    assert.equal((await sentTo(QUEUE, appKey(c.app.id))).filter((e) => e.type === 'AttemptEnded').at(-1).payload.reason, 'checks');

    // The head and the approval epoch the gate measured are compared with the
    // row's under the lock: a push, or an unpromote and a re-promote, between
    // the gate and the claim refuse it (proposal trace bugs 1, 2).
    for (const [column, value, reason] of [['reviewed_head_sha', SHA('c'), 'head_moved'], ['approval_epoch', 1, 'epoch_moved']]) {
      defaults();
      const m = await proposalRow();
      await vote(m, await user(), 'yes');
      let moved = false;
      work.answer.set(WORK.gate, async (input) => {
        const { rows: [x] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [input.sessionId]);
        if (!moved) {
          moved = true;
          await asTransition((cl) => cl.query(`UPDATE chat_sessions SET ${column} = $2 WHERE id = $1`, [m.id, value]));
        }
        return ready(x, { epoch: Number(x.approval_epoch) });
      });
      await want(m.app, { sessionId: m.id });
      await settle();
      assert.ok(!calls(WORK.attempt).some((x) => x.input.sessionId === m.id && x.input.head === SHA('a')), `${reason}: never asked GitHub`);
      const reasons = (await sentTo(QUEUE, appKey(m.app.id))).filter((e) => e.type === 'AttemptEnded').map((e) => e.payload.reason);
      assert.equal(reasons[0], reason);
    }
  });

  await t.test('M3 one attempt per app at a time; an ask during it makes one more pass; each candidate once per pass (M3)', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    const s1 = await proposalRow({ appRow: a, owner });
    const s2 = await proposalRow({ appRow: a, owner });
    for (const s of [s1, s2]) await vote(s, await user(), 'yes');
    let release;
    work.hold.set(WORK.attempt, new Promise((r) => { release = r; }));
    await want(a);
    await want(a);
    await rt.drain();
    const running = rt.runServices();
    await running; // the gate work this pass claimed has finished; the attempt is another pass
    await rt.drain();
    const q = await qInst(a);
    assert.equal(q.state, 'working');
    assert.ok(q.data.attempt, 'one attempt in flight');
    assert.equal(q.data.owed, true, 'the second ask is one more pass');
    const asked = (await pool.query(
      `SELECT count(*)::int AS n FROM wf_events WHERE machine = $1 AND type = 'MergeRequested' AND key = ANY($2::text[])`,
      [MACHINE, [sessionKey(s1.id), sessionKey(s2.id)]])).rows[0].n;
    assert.equal(asked, 1, 'never two attempts of one app at once');
    release();
    await running;
    await settle();
    assert.equal(calls(WORK.attempt).length, 2, 'both merged, one after the other');
    assert.equal((await qInst(a)).state, 'idle');
  });

  await t.test('M4 a refusal is named, once per head, and is not tried again until something changes (bug 2)', async () => {
    defaults();
    const s = await proposalRow();
    await vote(s, await user(), 'yes');
    work.answer.set(WORK.attempt, { outcome: 'refused', kind: 'blocked', message: 'PR #x wasn\'t merged: GitHub refused it (rules).' });
    await want(s.app);
    await settle();
    await want(s.app);
    await settle();
    assert.equal(calls(WORK.attempt).length, 1, 'the same refusal is not asked again by an ask that does not name it');
    assert.equal((await lines(s)).filter((l) => l.includes('GitHub refused it')).length, 1);
    const r = await row(s);
    assert.equal(r.status, 'promoted');
    assert.equal(r.behind_main, 0, 'no "behind" count for a refusal');
    assert.notEqual(r.merge_conflict_state, 'conflict', 'a branch rule is not a conflict');
    // A vote names it: tried again, still said once.
    await want(s.app, { sessionId: s.id });
    await settle();
    assert.equal(calls(WORK.attempt).length, 2);
    assert.equal((await lines(s)).filter((l) => l.includes('GitHub refused it')).length, 1, 'said once');
    // A conflict says so on the card.
    defaults();
    const c = await proposalRow();
    await vote(c, await user(), 'yes');
    work.answer.set(WORK.attempt, { outcome: 'refused', kind: 'conflict', message: 'conflict' });
    await want(c.app);
    await settle();
    assert.equal((await row(c)).merge_conflict_state, 'conflict');
    assert.equal((await row(c)).behind_main, 0);
  });

  await t.test('M5 GitHub never answered: unconfirmed until it says; nothing closes or unpromotes it meanwhile (bug 1)', async () => {
    defaults();
    const s = await proposalRow();
    await vote(s, await user(), 'yes');
    work.answer.set(WORK.attempt, () => { throw new Error('socket hang up'); });
    await want(s.app);
    await settle();
    const i = await pInst(s);
    assert.equal(i.state, 'unconfirmed');
    assert.equal((await row(s)).status, 'merging', 'it reads merging');
    assert.equal((await qInst(s.app)).state, 'idle', 'the queue goes on with the others');
    // Admin → Workflows lists it under "Needs a person" (Q3), with the words.
    const listed = (await inspect.problems(pool, { attention: attentionStates() })).waiting;
    const mine = listed.find((w) => w.machine === MACHINE && w.key === sessionKey(s.id));
    assert.ok(mine, 'an unconfirmed merge needs a person');
    assert.match(mine.says, /has not answered/);
    const close = await toProposal(s, 'Close', { from: 'merging', reason: 'manual' }, { kind: 'route' });
    const unpromote = await toProposal(s, 'Unpromote', { from: 'merging', userId: s.owner.id }, { kind: 'route' });
    const sync = await toProposal(s, 'SyncRequested', { reason: 'person' }, { kind: 'route' });
    await settle();
    assert.equal((await outcome(close)).reason, 'merging');
    assert.equal((await outcome(unpromote)).reason, 'merging');
    assert.equal((await outcome(sync)).reason, 'merging');
    // GitHub could not be read: asked again later.
    work.answer.set(WORK.observe, () => { throw new Error('ETIMEDOUT'); });
    await fire(MACHINE, sessionKey(s.id));
    assert.equal((await pInst(s)).state, 'unconfirmed');
    assert.ok((await pInst(s)).deadline_at, 'asked again later');
    // GitHub says it merged: merge-followups is told, as by the attempt.
    work.answer.set(WORK.observe, { merged: true, sha: SHA('8'), mergedAt: new Date().toISOString() });
    await fire(MACHINE, sessionKey(s.id));
    const told = await sentTo('merge-followups', sessionKey(s.id));
    assert.equal(told.length, 1);
    assert.equal(told[0].payload.mergeSha, SHA('8'));
    // Not merged: back up for its vote, said in its thread.
    defaults();
    const n = await proposalRow();
    await vote(n, await user(), 'yes');
    work.answer.set(WORK.attempt, () => { throw new Error('502'); });
    await want(n.app);
    await settle();
    work.answer.set(WORK.observe, { merged: false, state: 'open' });
    await fire(MACHINE, sessionKey(n.id));
    assert.equal((await pInst(n)).state, 'in_review');
    assert.equal((await row(n)).status, 'promoted');
    assert.ok((await lines(n)).some((l) => l.includes('GitHub says it did not merge')));
    const after = (await inspect.problems(pool, { attention: attentionStates() })).waiting;
    assert.ok(!after.some((w) => w.key === sessionKey(n.id)), 'answered, it no longer needs anybody');
  });

  await t.test('M6 the other outcomes: a head move keeps its votes or not; a closed PR leaves the vote; a reopened one is tried again', async () => {
    defaults();
    const s = await proposalRow();
    await vote(s, await user(), 'yes');
    work.answer.set(WORK.attempt, { outcome: 'head_moved', votesKept: false, reviewedHeadSha: SHA('c'), message: 'its GitHub head changed after review' });
    await want(s.app);
    await settle();
    assert.equal((await pInst(s)).state, 'in_review');
    assert.ok((await lines(s)).some((l) => l.includes('its GitHub head changed')));
    defaults();
    const c = await proposalRow();
    await vote(c, await user(), 'yes');
    work.answer.set(WORK.attempt, { outcome: 'closed', message: 'closed' });
    await want(c.app);
    await settle();
    assert.equal((await pInst(c)).state, 'underway', 'off the vote');
    assert.deepEqual([(await row(c)).status, (await row(c)).approval_epoch], ['paused', 1], 'its votes voided (PL19)');
    // An imported one stays as imports are: it holds no slot (bug 19).
    defaults();
    const imp = await proposalRow({ source: 'imported' });
    await vote(imp, await user(), 'yes');
    work.answer.set(WORK.attempt, { outcome: 'closed', message: 'closed' });
    await want(imp.app);
    await settle();
    assert.deepEqual([(await row(imp)).status, (await row(imp)).approval_epoch], ['active', 1]);
    defaults();
    const o = await proposalRow();
    await vote(o, await user(), 'yes');
    let n = 0;
    work.answer.set(WORK.attempt, () => (++n === 1 ? { outcome: 'reopened' } : { outcome: 'merged', sha: SHA('7') }));
    await want(o.app);
    await settle();
    await want(o.app, { sessionId: o.id });
    await settle();
    assert.equal((await sentTo('merge-followups', sessionKey(o.id))).length, 1, 'merged once reopened');
  });

  // ── Syncs with main ─────────────────────────────────────────────────

  await t.test('M7 a sync never runs while the proposal is being merged, and no merge is asked while it syncs (bug 8)', async () => {
    defaults();
    const s = await proposalRow();
    await vote(s, await user(), 'yes');
    let release;
    work.hold.set(WORK.sync, new Promise((r) => { release = r; }));
    const sync = await toProposal(s, 'SyncRequested', { reason: 'person' }, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(sync)).result, 'accepted');
    const running = rt.runServices();
    await waitFor(() => calls(WORK.sync).length === 1, { label: 'the sync to start' });
    await want(s.app);
    await rt.drain();
    await rt.drain();
    const asked = (await pool.query(`SELECT count(*)::int AS n FROM wf_events WHERE machine = $1 AND key = $2 AND type = 'MergeRequested'`,
      [MACHINE, sessionKey(s.id)])).rows[0].n;
    assert.equal(asked, 0, 'the queue does not ask for a proposal that syncs');
    const direct = await toProposal(s, 'MergeRequested', { queueN: 77, force: false }, fromQueueSrc);
    await rt.drain();
    assert.equal((await outcome(direct)).result, 'accepted');
    const ended = (await sentTo(QUEUE, appKey(s.app.id))).filter((e) => e.type === 'AttemptEnded' && e.payload.n === 77);
    assert.equal(ended.at(-1)?.payload.reason, 'syncing', 'and declines one that arrives anyway');
    const second = await toProposal(s, 'SyncRequested', { reason: 'person' }, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(second)).reason, 'in_progress', 'one sync at a time (bug 12)');
    release();
    await running;
    await settle();
    assert.equal((await pInst(s)).data.lastSync.outcome, 'clean');
    // And merging: a sync is refused.
    defaults();
    const m = await proposalRow();
    await vote(m, await user(), 'yes');
    let go;
    work.hold.set(WORK.attempt, new Promise((r) => { go = r; }));
    await want(m.app);
    await rt.drain();
    const gating = rt.runServices();
    await gating;
    await rt.drain();
    const merging = rt.runServices();
    await waitFor(() => calls(WORK.attempt).length === 1, { label: 'the merge attempt to start' });
    await rt.drain();
    assert.equal((await pInst(m)).state, 'merging');
    const refused = await toProposal(m, 'SyncRequested', { reason: 'person' }, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(refused)).reason, 'merging');
    go();
    await merging;
    await settle();
  });

  await t.test('M8 a platform sync\'s once-record is written with the sync: never "already tried" without a sync (bug 9)', async () => {
    defaults();
    const s = await proposalRow({ checks: 'error', clean: true });
    const head = SHA('a');
    const first = await toProposal(s, 'SyncRequested', { reason: 'boot_failure', head }, { kind: 'message', from: { machine: 'preview', key: 'x', eventId: 1 } });
    await rt.drain();
    assert.equal((await outcome(first)).result, 'accepted');
    assert.equal((await row(s)).boot_failure_sync_head, head, 'recorded in the same transaction as the work');
    const queued = (await pool.query(`SELECT status FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3`,
      [MACHINE, sessionKey(s.id), WORK.sync])).rows;
    assert.equal(queued.length, 1, 'and the sync is durable work: a restart resumes it');
    await settle();
    const again = await toProposal(s, 'SyncRequested', { reason: 'boot_failure', head }, { kind: 'message', from: { machine: 'preview', key: 'x', eventId: 1 } });
    await rt.drain();
    assert.equal((await outcome(again)).reason, 'already_tried');
    // A fixed check: its head and keys.
    defaults();
    const f = await proposalRow({ checks: 'failing' });
    const fx = await toProposal(f, 'SyncRequested', { reason: 'fixed_check', head: SHA('a'), keys: ['a.js::x'] });
    await settle();
    assert.equal((await outcome(fx)).result, 'accepted');
    assert.deepEqual((await row(f)).fixed_check_sync_keys, ['a.js::x']);
    const hand = await toProposal(f, 'SyncRequested', { reason: 'bot_handoff', head: SHA('a') });
    await settle();
    assert.equal((await outcome(hand)).reason, 'already_tried', 'once per head');
    // The guard refuses anybody else's write of them once held.
    await assert.rejects(pool.query('UPDATE chat_sessions SET boot_failure_sync_head = NULL WHERE id = $1', [s.id]), /WF_OWNERSHIP_VIOLATION|owned/);
  });

  await t.test('M9 the conflict lane: one resolution per app, held while a direct merge is under way; an unresolvable conflict is not paid for twice (bug 11)', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    const clean = await proposalRow({ appRow: a, owner });
    const conflicting = await proposalRow({ appRow: a, owner, clean: false });
    for (const s of [clean, conflicting]) await vote(s, await user(), 'yes');
    let release;
    work.hold.set(WORK.attempt, new Promise((r) => { release = r; }));
    await want(a);
    await rt.drain();
    const running = rt.runServices();
    await running; // the gate work this pass claimed has finished, so the next drain starts the merge
    await rt.drain();
    assert.equal(calls(WORK.sync).length, 0, 'held while the direct merge is under way');
    release();
    await running;
    work.answer.set(WORK.sync, { outcome: 'unresolvable', headBefore: SHA('a'), mainSha: SHA('e'), message: 'could not' });
    await settle();
    assert.equal(calls(WORK.sync).length, 1, 'then one resolution');
    assert.equal(calls(WORK.sync)[0].input.reason, 'conflict');
    assert.deepEqual((await row(conflicting)).integration_block_reasons, ['unresolvable']);
    assert.ok((await lines(conflicting)).some((l) => l.includes('could not be resolved automatically')));
    // Asked again (a release, a vote): not paid for again against this main.
    await want(a);
    await settle();
    assert.equal(calls(WORK.sync).length, 1, 'the same (head, main) is not asked of the AI twice');
    // Main moves: a new question.
    await pool.query('UPDATE chat_sessions SET integration_main_sha = $2 WHERE id = $1', [conflicting.id, SHA('f')]);
    await want(a);
    await settle();
    assert.equal(calls(WORK.sync).length, 2);
  });

  await t.test('M10 rule C: an unapproved conflicting head gets one resolution per epoch, then waits for the vote', async () => {
    defaults();
    const s = await proposalRow({ clean: false, approvalsRequired: 3 });
    await want(s.app);
    await settle();
    assert.equal(calls(WORK.sync).length, 1, 'its first conflict is resolved before the vote');
    assert.equal(Number((await row(s)).integration_resolved_epoch), 0, 'spent, with the sync');
    await want(s.app);
    await settle();
    assert.equal(calls(WORK.sync).length, 1);
    assert.deepEqual((await row(s)).integration_block_reasons, ['awaiting_approval']);
  });

  await t.test('M11 a force lasts through a resolution until it merges; an authored push ends it (bug 6, M4)', async () => {
    defaults();
    const s = await proposalRow({ clean: false, approvalsRequired: 5 });
    const f = await toProposal(s, 'ForceMerge', { from: 'promoted', userId: s.owner.id, username: 'admin' }, { kind: 'route' });
    await settle();
    assert.equal((await outcome(f)).result, 'accepted');
    assert.equal(calls(WORK.sync).length, 1, 'a forced conflict is resolved at once');
    assert.equal(calls(WORK.sync)[0].input.reason, 'conflict');
    assert.ok((await pInst(s)).data.force, 'the force stands through the resolution');
    // Resolved: the head merges clean now, and the force merges it.
    await pool.query('UPDATE chat_sessions SET integration_merges_clean = TRUE WHERE id = $1', [s.id]);
    await want(s.app, { sessionId: s.id });
    await settle();
    assert.equal(calls(WORK.gate).at(-1).input.force, true);
    assert.equal(calls(WORK.attempt).length, 1);
    assert.equal((await sentTo('merge-followups', sessionKey(s.id)))[0].payload.force, true);
    // An authored push ends a force.
    defaults();
    const p = await proposalRow({ approvalsRequired: 5 });
    await toProposal(p, 'ForceMerge', { from: 'promoted', userId: p.owner.id, username: 'admin' }, { kind: 'route' });
    await rt.drain();
    assert.ok((await pInst(p)).data.force);
    await toProposal(p, 'ReviewHeadMoved', { column: 'reviewed', from: SHA('a'), to: SHA('d'), keepVotes: false });
    await rt.drain();
    assert.equal((await pInst(p)).data.force, null);
    await settle();
  });

  await t.test('M11b a force skips the checks only where it was given: a resolved head merges on its own green checks, a mechanical one keeps the force (2 Nov 2026)', async () => {
    defaults();
    // Forced at a, conflicting: resolved at once, and the force stands.
    const s = await proposalRow({ clean: false, approvalsRequired: 5 });
    await toProposal(s, 'ForceMerge', { from: 'promoted', userId: s.owner.id, username: 'admin' }, { kind: 'route' });
    await settle();
    assert.equal(calls(WORK.sync).length, 1);
    assert.equal((await pInst(s)).data.force.head, SHA('a'), 'the force names the commit it was given on');
    // The resolution wrote b: the votes stay, and so does the force, still
    // about a. b's checks are under way.
    await toProposal(s, 'ReviewHeadMoved', { column: 'reviewed', from: SHA('a'), to: SHA('b'), keepVotes: true, reason: 'resolved' });
    await rt.drain();
    assert.equal((await pInst(s)).data.force.head, SHA('a'));
    await pool.query(`UPDATE chat_sessions SET check_state = 'pending', checks_commit_sha = $2, integration_merges_clean = TRUE,
                        integration_head_sha = $2 WHERE id = $1`, [s.id, SHA('b')]);
    await want(s.app, { sessionId: s.id });
    await settle();
    assert.equal(calls(WORK.gate).length, 0, 'not tried while its run is under way');
    assert.equal(calls(WORK.attempt).length, 0);
    // Red on b: still not merged, nor tried.
    await pool.query(`UPDATE chat_sessions SET check_state = 'failing' WHERE id = $1`, [s.id]);
    await want(s.app, { sessionId: s.id });
    await settle();
    assert.equal(calls(WORK.attempt).length, 0, 'a force about a is not one about b');
    // Even if the gate is asked (the claim is the last word).
    await toProposal(s, 'MergeRequested', { queueN: 501, force: true }, fromQueueSrc);
    await settle();
    assert.equal(calls(WORK.attempt).length, 0, 'the claim refuses b\'s red checks');
    assert.equal((await pInst(s)).state, 'in_review');
    // Green on b: the force merges it, with none of its five votes.
    await pool.query(`UPDATE chat_sessions SET check_state = 'passing' WHERE id = $1`, [s.id]);
    await want(s.app, { sessionId: s.id });
    await settle();
    assert.equal(calls(WORK.attempt).length, 1);
    assert.equal(calls(WORK.attempt)[0].input.head, SHA('b'));
    assert.equal((await sentTo('merge-followups', sessionKey(s.id)))[0].payload.force, true);

    // A mechanical merge of main is pure git over a: the force follows it,
    // red checks and all. The stale failing verdict was made against an
    // older main, so the conflict lane still resolves it first (#6531): the
    // free resolution is spent, and the head it writes is checked afresh.
    defaults();
    const m = await proposalRow({ clean: false, approvalsRequired: 5, checks: 'failing' });
    await toProposal(m, 'ForceMerge', { from: 'promoted', userId: m.owner.id, username: 'admin' }, { kind: 'route' });
    await settle();
    assert.equal(calls(WORK.sync).length, 1, 'a stale verdict does not block the conflict lane');
    assert.equal(calls(WORK.sync)[0].input.reason, 'conflict');
    await toProposal(m, 'ReviewHeadMoved', { column: 'reviewed', from: SHA('a'), to: SHA('c'), keepVotes: true, reason: 'mechanical' });
    await rt.drain();
    assert.equal((await pInst(m)).data.force.head, SHA('c'));
    await pool.query(`UPDATE chat_sessions SET checks_commit_sha = $2, integration_merges_clean = TRUE, integration_head_sha = $2
                       WHERE id = $1`, [m.id, SHA('c')]);
    await want(m.app, { sessionId: m.id });
    await settle();
    assert.equal(calls(WORK.attempt).length, 1);
    assert.equal(calls(WORK.attempt)[0].input.head, SHA('c'));
  });

  await t.test('M12 a proposal left merging with no attempt of this machine\'s is asked about once its claim is old; a merge it lost is recorded', async () => {
    defaults();
    const s = await proposalRow({ status: 'merging' });
    await pool.query('UPDATE chat_sessions SET merge_attempt_at = NOW() WHERE id = $1', [s.id]);
    await toProposal(s, 'Adopted', {});
    await settle();
    const i = await pInst(s);
    assert.deepEqual([i.state, i.data.claim.n, i.deadline_event?.type], ['merging', 0, 'ObserveDue'], 'adopted as the claim it was');
    assert.ok(Date.parse(i.deadline_at) > Date.now() + CLAIM_STALE_MS - 60000, 'GitHub is asked once the claim is old');
    assert.equal(calls(WORK.observe).length, 0, 'a live claim is its process\'s');
    await asTransition((x) => x.query(
      `UPDATE wf_instances SET data = jsonb_set(data, '{claim,at}', to_jsonb((now() - make_interval(secs => $3::bigint / 1000.0))::text))
        WHERE machine = $1 AND key = $2`, [MACHINE, sessionKey(s.id), CLAIM_STALE_MS + 1000]));
    await fire(MACHINE, sessionKey(s.id));
    assert.equal(calls(WORK.observe).length, 1);
    assert.equal((await sentTo('merge-followups', sessionKey(s.id))).length, 1, 'GitHub merged it: recorded');
  });

  await t.test('M13 every answer reaches the queue: a closed, merged or missing proposal is declined, never left unanswered', async () => {
    defaults();
    const s = await proposalRow();
    await toProposal(s, 'Close', { from: 'promoted', reason: 'manual' }, { kind: 'route' });
    await settle();
    const asked = await toProposal(s, 'MergeRequested', { queueN: 99, force: false }, fromQueueSrc);
    const synced = await toProposal(s, 'SyncRequested', { reason: 'conflict', queueN: 98 }, fromQueueSrc);
    await rt.drain();
    assert.equal((await outcome(asked)).result, 'accepted');
    assert.equal((await outcome(synced)).result, 'accepted');
    const told = await sentTo(QUEUE, appKey(s.app.id));
    assert.ok(told.some((e) => e.type === 'AttemptEnded' && e.payload.n === 99 && e.payload.outcome === 'declined'));
    assert.ok(told.some((e) => e.type === 'ResolutionEnded' && e.payload.n === 98 && e.payload.outcome === 'declined'));
  });

  await t.test('M14 a close during a sync or a gate ends it and tells the queue', async () => {
    defaults();
    const s = await proposalRow({ clean: false });
    await vote(s, await user(), 'yes');
    await want(s.app);
    await rt.drain();
    assert.ok((await pInst(s)).data.sync, 'a sync asked for, not started');
    await toProposal(s, 'Close', { from: 'promoted', reason: 'manual' }, { kind: 'route' });
    await rt.drain();
    const w = (await pool.query(`SELECT status, result FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3`,
      [MACHINE, sessionKey(s.id), WORK.sync])).rows[0];
    assert.equal(w.status, 'settled', 'cancelled');
    await rt.drain();
    assert.equal((await qInst(s.app)).data.resolution, null, 'the queue heard');
    await settle();
    assert.equal(calls(WORK.sync).length, 0, 'never ran');

    // The author's move back waits for a gate under way (refused busy), and
    // once the gate claims it, it reads merging: the merge and the move back
    // exclude each other (#3114).
    defaults();
    const u = await proposalRow();
    await vote(u, await user(), 'yes');
    let release;
    work.hold.set(WORK.gate, new Promise((r) => { release = r; }));
    await want(u.app);
    await rt.drain();
    const gating = rt.runServices();
    await waitFor(() => calls(WORK.gate).length === 1, { label: 'the gate to start' });
    const during = await toProposal(u, 'Unpromote', { from: 'promoted', userId: u.owner.id }, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(during)).reason, 'busy');
    work.hold.delete(WORK.gate);
    release();
    await gating;
    await rt.drain();
    assert.equal((await pInst(u)).state, 'merging');
    const after = await toProposal(u, 'Unpromote', { from: 'promoted', userId: u.owner.id }, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(after)).reason, 'merging');
    assert.equal((await row(u)).status, 'merging');
    await settle();
  });

  // ── After the adversarial review ────────────────────────────────────

  await t.test('M15 a merge that lands while the gate or a sync runs ends the queue\'s slot at once (review: queue 1)', async () => {
    defaults();
    const s = await proposalRow();
    await vote(s, await user(), 'yes');
    await want(s.app, { sessionId: s.id });
    await rt.drain();
    assert.ok((await qInst(s.app)).data.attempt, 'the gate is asked for');
    // Merged by hand on GitHub, found by the boot observer: merge-followups
    // moves it into merged and tells the proposal.
    await toProposal(s, 'Merged', {});
    await rt.drain();
    const gate = (await pool.query(`SELECT status FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3`,
      [MACHINE, sessionKey(s.id), WORK.gate])).rows[0];
    assert.equal(gate.status, 'settled', 'the gate is cancelled');
    await rt.drain();
    assert.equal((await qInst(s.app)).data.attempt, null, 'the queue heard');

    const c = await proposalRow({ clean: false });
    await vote(c, await user(), 'yes');
    await want(c.app);
    await rt.drain();
    assert.ok((await qInst(c.app)).data.resolution, 'a resolution is asked for');
    await toProposal(c, 'Merged', {});
    await rt.drain();
    await rt.drain();
    assert.equal((await qInst(c.app)).data.resolution, null, 'the conflict lane is free again');
    await settle();
    assert.equal(calls(WORK.sync).length, 0, 'the sync never ran on a merged branch');
  });

  await t.test('M16 the queue\'s guard frees a slot its proposal no longer holds, and its deadline is not pushed back by asks (review: queue 1, 2)', async () => {
    defaults();
    const s = await proposalRow();
    await vote(s, await user(), 'yes');
    let release;
    work.hold.set(WORK.gate, new Promise((r) => { release = r; }));
    await want(s.app, { sessionId: s.id });
    await rt.drain();
    // The deadline is the transition's clock plus a long guard, so a clock
    // tick means the database's clock has moved past the moment it was read,
    // not past the deadline itself.
    const { rows: [slot] } = await pool.query(
      'SELECT deadline_at, clock_timestamp() AS read_at FROM wf_instances WHERE machine = $1 AND key = $2',
      [QUEUE, appKey(s.app.id)]);
    const first = slot.deadline_at;
    assert.ok(first, 'the guard is set with the slot');
    await waitFor(async () => {
      const { rows: [tick] } = await pool.query('SELECT clock_timestamp() AS now');
      return new Date(tick.now).getTime() > new Date(slot.read_at).getTime();
    }, { label: 'the database clock to move past the moment the slot was read' });
    await want(s.app);
    await want(s.app);
    await rt.drain();
    assert.equal(new Date((await qInst(s.app)).deadline_at).getTime(), new Date(first).getTime(), 'asks while working leave it where it was');
    // The proposal lost its attempt some other way (its row written by an
    // older release): the guard frees the slot and looks at the line again.
    await asTransition((x) => x.query(`UPDATE wf_instances SET state = 'closed', data = data - 'attempt' WHERE machine = $1 AND key = $2`,
      [MACHINE, sessionKey(s.id)]));
    await due(QUEUE, appKey(s.app.id));
    await rt.fireTimers();
    await rt.drain();
    const q = await qInst(s.app);
    assert.equal(q.data.attempt, null);
    release();
    await settle();
  });

  await t.test('M17 an idle queue with a line sweeps it: what nobody asks about is looked at (review: queue 3, 6)', async () => {
    defaults();
    const s = await proposalRow();
    await want(s.app);
    await settle();
    const q = await qInst(s.app);
    assert.equal(q.state, 'idle');
    assert.ok(q.deadline_at, 'a sweep is due');
    // A Yes nobody announced (a vote window that elapsed reads the same).
    await vote(s, await user(), 'yes');
    await fire(QUEUE, appKey(s.app.id));
    assert.equal(calls(WORK.attempt).length, 1, 'the sweep merged it');
    const empty = await proposalRow();
    await toProposal(empty, 'Close', { from: 'promoted', reason: 'manual' }, { kind: 'route' });
    await settle();
    await want(empty.app);
    await settle();
    assert.equal((await qInst(empty.app)).deadline_at, null, 'an empty line sets no sweep');
  });

  await t.test('M17b GitHub busy, or a plain refusal, comes back on the queue\'s sweep; a conflict stays held (request 6265)', async () => {
    assert.equal(REFUSAL_RETRY_MS, SWEEP_MS, 'a refusal expires with the queue\'s sweep');
    // Move the recorded retry into the past: the clock has advanced past it.
    const expire = (s) => asTransition((c) => c.query(
      `UPDATE wf_instances SET data = jsonb_set(data, '{refused,retryAt}', to_jsonb($3::text))
        WHERE machine = $1 AND key = $2`,
      [MACHINE, sessionKey(s.id), new Date(Date.now() - 1000).toISOString()]));
    for (const refusal of [
      { outcome: 'refused', kind: 'github_busy', reason: 'github_busy', message: 'PR #x wasn\'t merged yet: GitHub said a merge of it was already in progress.' },
      { outcome: 'refused', kind: 'blocked', reason: 'github_refused', message: 'PR #x wasn\'t merged: GitHub refused it (paused).' },
    ]) {
      defaults();
      const s = await proposalRow();
      await vote(s, await user(), 'yes');
      let n = 0;
      work.answer.set(WORK.attempt, () => {
        if (++n === 1) throw new Error('Server Error'); // a 5xx: no answer
        return n === 2 ? refusal : { outcome: 'merged', sha: SHA('9') };
      });
      await want(s.app, { sessionId: s.id });
      await settle();
      assert.equal(calls(WORK.attempt).length, 2, 'the 5xx is retried, then GitHub\'s answer is read');
      const held = await row(s);
      assert.deepEqual(held.integration_block_reasons, [refusal.reason], 'the card is told why it waits');
      // The time of the next try is the queue's own refusal record, which the
      // session reads carry beside those reasons (services/integration.js
      // HELD_UNTIL_SQL); there is no copy of it on the session row.
      const pi = await pInst(s);
      assert.ok(Date.parse(pi.data.refused.retryAt) > Date.now() - 1000,
        'and when the queue tries again');
      const { rows: [served] } = await pool.query(
        `SELECT ${require('../src/services/integration').HELD_UNTIL_SQL} AS merge_held_until
           FROM chat_sessions cs WHERE cs.id = $1`, [s.id]);
      assert.equal(served.merge_held_until, pi.data.refused.retryAt,
        'the read serves the queue\'s own retry time');
      // Nothing else happens on the app: only the queue's sweep, after the
      // recorded retry has passed, tries it again.
      await expire(s);
      await fire(QUEUE, appKey(s.app.id));
      assert.equal(calls(WORK.attempt).length, 3, 'the sweep tried it again');
      const told = await sentTo('merge-followups', sessionKey(s.id));
      assert.equal(told.length, 1, 'and it merged');
      assert.equal(told[0].payload.mergeSha, SHA('9'));
    }
    // A refusal that needs a person or a code change stays held: a conflict
    // is not asked again by the sweep.
    defaults();
    const c = await proposalRow();
    await vote(c, await user(), 'yes');
    work.answer.set(WORK.attempt, { outcome: 'refused', kind: 'conflict', message: 'conflict' });
    await want(c.app, { sessionId: c.id });
    await settle();
    assert.equal((await pInst(c)).data.refused.retryAt, null, 'sticky');
    const before = calls(WORK.attempt).length;
    await fire(QUEUE, appKey(c.app.id));
    assert.equal(calls(WORK.attempt).length, before, 'not asked again by the sweep');
  });

  await t.test('M18 GitHub\'s conflict on a head the mirror measures clean goes to the conflict lane, and the turn runs (review: queue 4, attempt 6)', async () => {
    defaults();
    const s = await proposalRow();
    await vote(s, await user(), 'yes');
    work.answer.set(WORK.attempt, { outcome: 'refused', kind: 'conflict', message: 'conflict' });
    work.answer.set(WORK.sync, { outcome: 'level', message: 'Already up to date.' });
    await want(s.app, { sessionId: s.id });
    await settle();
    const syncs = calls(WORK.sync);
    assert.equal(syncs.length, 1, 'a resolution is asked for');
    assert.equal(syncs[0].input.githubConflict, true, 'the turn runs although the mirror says clean');
    assert.ok((await pInst(s)).data.gaveUp, 'nothing a sync changes: the head is left alone against this main');
    await want(s.app);
    await settle();
    assert.equal(calls(WORK.sync).length, 1, 'not asked again for that head');
  });

  await t.test('M19 main moved under the merge: asked once more at once, and a second refusal is not remembered for the head (review: queue 5, attempt 5)', async () => {
    defaults();
    const s = await proposalRow();
    await vote(s, await user(), 'yes');
    let n = 0;
    work.answer.set(WORK.attempt, () => (++n === 1 ? { outcome: 'refused', kind: 'base_moved', message: 'Base branch was modified.' } : { outcome: 'merged', sha: SHA('7') }));
    await want(s.app, { sessionId: s.id });
    await settle();
    assert.equal(calls(WORK.attempt).length, 2);
    assert.equal((await sentTo('merge-followups', sessionKey(s.id))).length, 1, 'merged on the second ask');

    defaults();
    const t2 = await proposalRow();
    await vote(t2, await user(), 'yes');
    work.answer.set(WORK.attempt, { outcome: 'refused', kind: 'base_moved', message: 'Base branch was modified.' });
    await want(t2.app, { sessionId: t2.id });
    await settle();
    assert.equal(calls(WORK.attempt).length, 2, 'once more, not more');
    assert.equal((await pInst(t2)).state, 'in_review');
    assert.equal((await pInst(t2)).data.refused ?? null, null, 'not a refusal of this head');
    await want(t2.app);
    await settle();
    assert.equal(calls(WORK.attempt).length, 4, 'the next ask tries it again');
  });

  await t.test('M20 a force ends with a pull request closed for good, and never applies after it is proposed again (review: attempt 3)', async () => {
    defaults();
    const s = await proposalRow();
    await toProposal(s, 'ForceMerge', { from: 'promoted', userId: s.owner.id, username: 'admin' }, { kind: 'route' });
    work.answer.set(WORK.attempt, { outcome: 'closed', message: 'closed' });
    await settle();
    const i = await pInst(s);
    assert.equal(i.state, 'underway');
    assert.equal(i.data.force ?? null, null, 'the force went with it');
    assert.equal(i.data.attempt ?? null, null);
  });

  await t.test('M21 merge-followups is told again until the row reads merged (an older pod may refuse it in a rollout) (review: attempt 1)', async () => {
    defaults();
    const s = await proposalRow();
    await vote(s, await user(), 'yes');
    await want(s.app, { sessionId: s.id });
    await settle();
    assert.equal((await sentTo('merge-followups', sessionKey(s.id))).length, 1);
    assert.ok((await pInst(s)).deadline_at, 'its clock is set');
    await fire(MACHINE, sessionKey(s.id));
    const told = await sentTo('merge-followups', sessionKey(s.id));
    assert.equal(told.length, 2, 'told again');
    assert.equal(told[1].payload.mergeSha, SHA('9'), 'the same merge');
    // Recorded: merge-followups moved the row; the clock stops asking.
    await asTransition((x) => x.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [s.id]));
    await fire(MACHINE, sessionKey(s.id));
    assert.equal((await sentTo('merge-followups', sessionKey(s.id))).length, 2);
  });

  await t.test('M22 a proposal an older release left merging with no clock gets one again at boot (review: attempt 2)', async () => {
    defaults();
    const s = await proposalRow({ status: 'merging' });
    await toProposal(s, 'Adopted', {});
    await rt.drain();
    await asTransition((x) => x.query(`UPDATE wf_instances SET deadline_at = NULL, deadline_event = NULL, data = data - 'claim' WHERE machine = $1 AND key = $2`,
      [MACHINE, sessionKey(s.id)]));
    await toProposal(s, 'Rearm', {});
    await rt.drain();
    assert.ok((await pInst(s)).deadline_at, 'GitHub is asked what happened once the claim is old');
    await fire(MACHINE, sessionKey(s.id));
    assert.equal(calls(WORK.observe).length, 1);
  });

  await t.test('M23 a platform sync that did nothing gives its once-record back; one that ran keeps it (review: sync 6)', async () => {
    defaults();
    const s = await proposalRow({ checks: 'error' });
    work.answer.set(WORK.sync, { outcome: 'unmeasured' });
    await toProposal(s, 'SyncRequested', { reason: 'boot_failure', head: SHA('a') });
    await rt.drain();
    assert.equal((await row(s)).boot_failure_sync_head, SHA('a'), 'written with the sync\'s own work');
    await settle();
    assert.equal((await row(s)).boot_failure_sync_head, null, 'given back: it may be asked again for this head');
    work.answer.set(WORK.sync, { outcome: 'clean', sha: SHA('5') });
    await toProposal(s, 'SyncRequested', { reason: 'boot_failure', head: SHA('a') });
    await settle();
    assert.equal((await row(s)).boot_failure_sync_head, SHA('a'), 'once per head');
  });

  await t.test('M24 while a sync is asked for, nothing pauses the session or promotes it; a platform sync waits for a turn rather than refusing (review: sync 5, 7)', async () => {
    defaults();
    const s = await proposalRow({ status: 'active' });
    let release;
    work.hold.set(WORK.sync, new Promise((r) => { release = r; }));
    await toProposal(s, 'SyncRequested', { reason: 'person' }, { kind: 'route' });
    await rt.drain();
    assert.ok((await pInst(s)).data.sync);
    const pause = await toProposal(s, 'Pause', { from: 'active', reason: 'auto-idle' });
    await rt.drain();
    assert.equal((await outcome(pause)).reason, 'worked_on');
    release();
    await settle();

    defaults();
    const b = await proposalRow({ checks: 'error' });
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"t"}'::jsonb WHERE id = $1`, [b.id]);
    const asked = await toProposal(b, 'SyncRequested', { reason: 'boot_failure', head: SHA('a') });
    await rt.drain();
    assert.equal((await outcome(asked)).result, 'accepted', 'a turn running is waited for, in the work');
    assert.equal((await pool.query(`SELECT input FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3`,
      [MACHINE, sessionKey(b.id), WORK.sync])).rows[0].input.waitForIdle, true);
    const person = await toProposal(b, 'SyncRequested', { reason: 'person' }, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(person)).reason, 'in_progress');
    await settle();
  });

  await t.test('M25 the whole line is read: an approved proposal behind 200 older ones waiting for votes is merged (PR review)', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, branch_name, pr_number, pr_title, reviewed_head_sha, promoted_at,
                                  check_state, checks_commit_sha, integration_merges_clean, integration_head_sha, integration_main_sha)
       SELECT $1, $2, 'promoted', 'waiting-' || g, 50000 + g, 'Waiting', $3, NOW() - interval '2 days', 'passing', $3, TRUE, $3, $4
         FROM generate_series(1, 200) g`, [a.id, owner.id, SHA('b'), SHA('e')]);
    const s = await proposalRow({ appRow: a, owner });
    await vote(s, await user(), 'yes');
    await want(a, { sessionId: s.id });
    await settle();
    assert.deepEqual(calls(WORK.attempt).map((c) => c.input.sessionId), [s.id]);
    // Each is the proposal machine's from its insert (its Adopted): taken out
    // of the line as the kernel writes it.
    await asTransition((x) => x.query(`UPDATE chat_sessions SET status = 'archived' WHERE app_id = $1 AND branch_name LIKE 'waiting-%'`, [a.id]));
  });

  await t.test('M26 GitHub\'s hourly limit: back up for its vote with nothing remembered against the head; the next look asks again (PR review)', async () => {
    defaults();
    const s = await proposalRow();
    await vote(s, await user(), 'yes');
    work.answer.set(WORK.attempt, { outcome: 'rate_limited', message: 'GitHub\'s hourly limit for Homeroom is used up.' });
    await want(s.app, { sessionId: s.id });
    await settle();
    const i = await pInst(s);
    assert.equal(i.state, 'in_review');
    assert.equal(i.data.refused ?? null, null, 'not a refusal of this head');
    assert.equal(calls(WORK.attempt).length, 1);
    work.answer.set(WORK.attempt, { outcome: 'merged', sha: SHA('6') });
    await fire(QUEUE, appKey(s.app.id));
    assert.equal(calls(WORK.attempt).length, 2, 'the sweep, which names nobody, asks again');
    assert.equal((await sentTo('merge-followups', sessionKey(s.id))).length, 1);
  });

  await t.test('M27 a retry of a refused head that GitHub throttles, or that meets main moving twice, forgets the refusal: the sweep asks again (PR review)', async () => {
    for (const second of [{ outcome: 'rate_limited', message: null }, { outcome: 'refused', kind: 'base_moved', message: 'Base branch was modified.' }]) {
      defaults();
      const s = await proposalRow();
      await vote(s, await user(), 'yes');
      work.answer.set(WORK.attempt, { outcome: 'refused', kind: 'blocked', message: 'Required status check is expected.' });
      await want(s.app, { sessionId: s.id });
      await settle();
      assert.ok((await pInst(s)).data.refused, 'refused for this head');
      // A named ask retries it; GitHub answers with something that is no
      // refusal of the head.
      work.answer.set(WORK.attempt, second);
      await want(s.app, { sessionId: s.id });
      await settle();
      assert.equal((await pInst(s)).data.refused ?? null, null, `${second.outcome}: the earlier refusal is forgotten`);
      const asked = calls(WORK.attempt).length;
      work.answer.set(WORK.attempt, { outcome: 'merged', sha: SHA('6') });
      await fire(QUEUE, appKey(s.app.id));
      assert.equal(calls(WORK.attempt).length, asked + 1, 'the sweep, which names nobody, asks again');
    }
  });

  // Production, 16 to 21 Oct 2026: 17 of the 22 merges that took over two
  // minutes were an ask declined as busy (most a verdict's, while a
  // hand-off's check run still held its operation), then nothing until the
  // queue's sweep four minutes on.
  await t.test('M28 an ask declined as busy is asked again when the operation that kept the proposal moving ends, with no sweep', async () => {
    defaults();
    const s = await proposalRow();
    await vote(s, await user(), 'yes');
    // The preview machine records the operation and its end, on a runtime of
    // its own (this suite's runs the proposal and the queue).
    const vm = preview({ maxRetries: 6, retireAfterMs: 0 });
    const prt = createRuntime({ pool, machines: [vm], pollMs: 50, publish: async () => {}, services: {} });
    runtimes.push(prt);
    const toPreview = (type, payload) => prt.append(vm, sessionKey(s.id), { type, payload },
      { requestKey: `p-${++rk}`, source: system, appId: s.app_id });
    const live = await pool.connect();
    await live.query('SELECT pg_advisory_lock($1, hashtext($2) & 2147483647)', [PROCESS_PRESENCE_LOCK, 'm28-host']);
    try {
      await toPreview('OperationStarted', { sessionId: s.id, id: 'op:m28', kind: 'operation', holder: 'm28-host' });
      await prt.drain();
      // Its verdict asks while the check run still holds the operation.
      await want(s.app, { sessionId: s.id, reason: 'checks' });
      await settle();
      const ended = async () => (await sentTo(QUEUE, appKey(s.app.id))).filter((e) => e.type === 'AttemptEnded')
        .map((e) => [e.payload.outcome, e.payload.reason ?? null]);
      assert.deepEqual(await ended(), [['declined', 'busy']]);
      assert.equal(calls(WORK.gate).length, 0, 'not measured while it moves');
      const q = await qInst(s.app);
      assert.equal(q.state, 'idle');
      assert.ok(q.deadline_at, 'only the sweep would look at it again');
      // The operation ends: its end asks, and the merge follows; no timer fires.
      await toPreview('OperationEnded', { id: 'op:m28' });
      await prt.drain();
      await settle();
      assert.deepEqual((await sentTo(QUEUE, appKey(s.app.id))).filter((e) => e.type === 'MergeWanted').map((e) => e.payload.reason),
        ['operation-ended']);
      assert.equal(calls(WORK.attempt).length, 1, 'merged');
      assert.deepEqual(await ended(), [['declined', 'busy'], ['merged', null]]);
    } finally {
      live.release(true);
    }
  });

  // 21 Oct 2026: PR 5787 had its checks and its vote at 17:40:47, and the
  // queue's asks were declined busy twice while its before & after shots
  // were taken; it merged on an unrelated ask at 17:44:40.
  await t.test('M30 the shots agent\'s turn does not keep a proposal moving: a verdict\'s ask merges while shots are taken; any other turn is busy', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    const shooting = await proposalRow({ appRow: a, owner });
    await vote(shooting, await user(), 'yes');
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"m30","mode":"shots","phase":"executing"}'::jsonb WHERE id = $1`, [shooting.id]);
    await want(a, { sessionId: shooting.id, reason: 'checks' });
    await settle();
    assert.equal(calls(WORK.attempt).length, 1, 'merged while its shots are taken');
    const building = await proposalRow({ appRow: a, owner });
    await vote(building, await user(), 'yes');
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"m30b","mode":"build","phase":"executing"}'::jsonb WHERE id = $1`, [building.id]);
    await want(a, { sessionId: building.id, reason: 'checks' });
    await settle();
    const ended = (await sentTo(QUEUE, appKey(a.id))).filter((e) => e.type === 'AttemptEnded' && e.payload.sessionId === building.id)
      .map((e) => [e.payload.outcome, e.payload.reason ?? null]);
    assert.deepEqual(ended, [['declined', 'busy']], 'a coding turn may still move the branch');
    assert.equal(calls(WORK.attempt).length, 1);
  });

  await t.test('M29 an ask that names a proposal this pass declined tries it again, though a resolution holds the pass', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    const busy = await proposalRow({ appRow: a, owner });
    const conflicting = await proposalRow({ appRow: a, owner, clean: false });
    for (const s of [busy, conflicting]) await vote(s, await user(), 'yes');
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"id":"m29","phase":"executing"}'::jsonb WHERE id = $1`, [busy.id]);
    let release;
    work.hold.set(WORK.sync, new Promise((r) => { release = r; }));
    await want(a);
    await rt.drain();
    const running = rt.runServices();
    await waitFor(() => calls(WORK.sync).length === 1, { label: 'the conflicting resolution to start' });
    await rt.drain();
    assert.equal(calls(WORK.sync).length, 1, 'the conflicting one is being resolved');
    assert.equal(calls(WORK.gate).length, 0, 'the busy one was declined');
    // Its turn ends and its end asks: tried now, not after the resolution.
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [busy.id]);
    await want(a, { sessionId: busy.id });
    for (let i = 0; i < 4; i++) { await rt.drain(); await rt.runServices(); }
    await rt.drain();
    assert.equal(calls(WORK.attempt).length, 1, 'merged while the resolution still runs');
    assert.equal((await row(busy)).status, 'merging');
    release();
    await running;
    await settle();
  });

  void DAY;
});
