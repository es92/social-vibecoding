'use strict';

// The proposal machine (src/workflow/proposal/) against the full PostgreSQL
// schema: adoption from the row, every move from every state it can be made
// in, the caps counted under locks, the vote gate read again under the lock,
// the review check, one close for every reason, the GitHub moves run one at
// a time, the messages to the preview and shots machines, merge-followups'
// Merged, and the ownership guard. The work is fake; the real handlers are
// src/workflow/proposal/services.ts. Each [main] bug the step fixes (the
// design note's §4, numbered as the trace numbers them) is named where it is
// pinned.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/workflow-proposal-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const platform = require('../src/workflow/platform.ts');
const { proposal, sessionKey, MACHINE, WORK } = require('../src/workflow/proposal/machine.ts');
const { createChangeClosedNotification } = require('../src/workflow/rules/change-notifications.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);
const DAY = 24 * 60 * 60 * 1000;
const DEPS = { idleMs: 5 * 60 * 1000, exemptFixtures: false, reviewCheckMs: 60 * 60 * 1000, staleNotifyMs: 7 * DAY, staleGraceMs: 3 * DAY };

test('proposal machine against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_proposal_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 12 });
  pool.on('error', () => {});
  const runtimes = [];
  // A gate a subtest may leave shut (it failed midway): `hold` parks the
  // handler and remembers the key, so every subtest ends with its gates open
  // and a parked fake cannot hold `stop()` open.
  const held = [];
  const hold = (kind) => {
    let release;
    work.gate.set(kind, new Promise((r) => { release = r; }));
    held.push(release);
    return release;
  };
  const openAll = () => { for (const r of held.splice(0)) r(); };
  t.after(async () => {
    openAll();
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:${MACHINE}', '1'), ('enabled:merge-followups', '1')
                    ON CONFLICT DO NOTHING`);

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  async function user({ synthetic = false } = {}) {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, is_synthetic) VALUES ($1, 'x', $2) RETURNING id, username`, [`pr_${++seq}`, synthetic]);
    return u;
  }
  async function app(owner, { approvalsRequired = null } = {}) {
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, repo_url, approvals_required)
       VALUES ($1::text, $1::text, $2, 'https://github.com/acme/' || $1::text, $3) RETURNING *`,
      [`pr-app-${++seq}`, owner.id, approvalsRequired]);
    return a;
  }
  async function session({ status = 'active', source = null, head = SHA('a'), owner = null, appRow = null, pr = true,
    headless = false, promotedAgo = null, approvalsRequired = null, lastActivityAgo = 0 } = {}) {
    const o = owner || await user();
    const a = appRow || await app(o, { approvalsRequired });
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, source, branch_name, pr_number, pr_title, reviewed_head_sha,
                                  imported_pr_head_sha, is_headless, promoted_at, last_activity_at)
       VALUES ($1, $2, $3, $4, 'feature', $5, 'Make it better', $6, $7, $8,
               CASE WHEN $9::bigint IS NULL THEN NULL ELSE NOW() - make_interval(secs => $9::bigint / 1000.0) END,
               NOW() - make_interval(secs => $10::bigint / 1000.0))
       RETURNING *`,
      [a.id, o.id, status, source, pr ? ++seq : null, source === 'imported' ? null : head,
        source === 'imported' ? head : null, headless, promotedAgo, lastActivityAgo]);
    return { ...s, app: a, owner: o };
  }
  const row = async (s) => (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [s.id])).rows[0];
  const instance = async (s) => (await pool.query(
    'SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(s.id)])).rows[0];
  const workOf = async (s, kind) => (await pool.query(
    `SELECT kind, work_key, input, status, result FROM wf_work WHERE machine = $1 AND key = $2 AND ($3::text IS NULL OR kind = $3)
      ORDER BY created_at, work_key`, [MACHINE, sessionKey(s.id), kind || null])).rows;
  // What this machine asked of the others, in order.
  const sentTo = async (s, machine) => (await pool.query(
    `SELECT type, payload, source FROM wf_events WHERE machine = $1 AND key = $2 AND source->'from'->>'machine' = $3 ORDER BY id`,
    [machine, sessionKey(s.id), MACHINE])).rows;
  const asTransition = async (fn) => {
    const c = await pool.connect();
    try { await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`); await fn(c); await c.query('COMMIT'); } finally { c.release(); }
  };
  const due = (s) => asTransition((c) => c.query(
    'UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(s.id)]));
  const vote = (s, u, v, epoch = null) => pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, head_sha, approval_epoch)
     SELECT $1, $2, $3, cs.reviewed_head_sha, COALESCE($4, cs.approval_epoch) FROM chat_sessions cs WHERE cs.id = $1
     ON CONFLICT (session_id, user_id) DO UPDATE SET vote = EXCLUDED.vote, approval_epoch = EXCLUDED.approval_epoch, created_at = NOW()`,
    [s.id, u.id, v, epoch]);

  // Fake work: each call recorded; `answer` per kind (a value, or a
  // function of the input, which may throw).
  const work = { calls: [], answer: new Map(), gate: new Map() };
  const fake = (kind) => ({
    maxAttempts: 1, backoffMs: () => 0, leaseMs: 600,
    async run({ input, key }) {
      work.calls.push({ kind, key, input });
      if (work.gate.has(kind)) await work.gate.get(kind);
      const a = work.answer.get(kind);
      return typeof a === 'function' ? await a(input) : (a ?? { ok: true });
    },
  });
  const defaults = () => {
    work.calls.length = 0;
    work.gate.clear();
    work.answer.set(WORK.open, () => ({ head: SHA('a'), prNumber: 77, prUrl: 'https://github.com/acme/x/pull/77', prTitle: 'Make it better' }));
    work.answer.set(WORK.close, { closed: true });
    work.answer.set(WORK.reopen, { reopened: true });
  };
  defaults();
  t.afterEach(openAll);
  const pushed = [];
  const machine = proposal(DEPS);
  const rt = createRuntime({
    pool, machines: [machine], pollMs: 50, publish: async (q, list) => { pushed.push(...list); },
    services: Object.fromEntries(Object.values(WORK).map((k) => [k, fake(k)])),
  });
  runtimes.push(rt);

  let rk = 0;
  const route = { kind: 'route' };
  const system = { kind: 'system' };
  const fromMerge = { kind: 'message', from: { machine: 'merge-followups', key: 'x', eventId: 1 } };
  const send = (s, type, payload = {}, source = system) => rt.append(machine, sessionKey(s.id),
    { type, payload: { sessionId: s.id, ...payload } }, { requestKey: `t-${++rk}`, source, appId: s.app_id });
  const settle = async () => {
    for (let i = 0; i < 30; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  const outcome = async (id) => (await pool.query('SELECT result, reason, state_after, reply FROM wf_events WHERE id = $1', [id])).rows[0];
  const calls = (kind) => work.calls.filter((c) => c.kind === kind);
  // Waits until the runtime has claimed `n` items of `kind` — the fake
  // records the call before it parks on its gate — and fails clearly after
  // 10s, rather than sleeping a fixed while and hoping the claim happened.
  const untilCalled = async (kind, n = 1) => {
    for (let waited = 0; waited < 10000 && calls(kind).length < n; waited += 10) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (calls(kind).length < n) assert.fail(`${kind} was never claimed`);
  };
  // Waits until a work item that ran ungated has reported and its report has
  // been applied (the report and its event are written in one transaction;
  // the drain settles the row and clears it from `doomed`). A move read
  // after this does not see the item as teardown still under way.
  const untilSettled = async (s, kind) => {
    for (let waited = 0; waited < 10000; waited += 10) {
      await rt.drain();
      const items = await workOf(s, kind);
      if (items.length && items[0].status === 'settled') return;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail(`${kind} was never settled`);
  };
  const promote = (s, extra = {}) => send(s, 'Promote', {
    from: s.status, userId: s.owner.id, username: s.owner.username, cap: 5, pr: null, ...extra,
  }, route);
  const fire = async (s) => { await due(s); await rt.fireTimers(); await settle(); };
  // Lapses a running item's lease in the database, the way a stalled process
  // would, instead of waiting real time out (a claimed item's heartbeat
  // renews its lease, so no sleep could lapse it anyway).
  const lapse = (s, kind) => pool.query(
    `UPDATE wf_work SET lease_until = now() - interval '1 second' WHERE machine = $1 AND key = $2 AND kind = $3 AND status = 'running'`,
    [MACHINE, sessionKey(s.id), kind]);

  // ── Adoption ────────────────────────────────────────────────────────

  await t.test('P1 a row is adopted as it stands, its timer armed', async () => {
    const active = await session({ status: 'active' });
    const paused = await session({ status: 'paused' });
    const review = await session({ status: 'promoted', promotedAgo: 0 });
    const merged = await session({ status: 'merged' });
    for (const s of [active, paused, review, merged]) await send(s, 'Adopted');
    await settle();
    assert.equal((await instance(active)).state, 'underway');
    assert.equal((await instance(active)).data.slot, 'held');
    assert.equal((await instance(active)).deadline_event.type, 'IdleCheck', 'a held slot is looked at once it may be idle');
    assert.equal((await instance(paused)).data.slot, 'released');
    assert.equal((await instance(paused)).deadline_at, null);
    assert.equal((await instance(review)).state, 'in_review');
    assert.equal((await instance(review)).deadline_event.type, 'ReviewCheck');
    assert.equal((await instance(merged)).state, 'merged');
    // Adopting again is nothing.
    const again = await send(active, 'Adopted');
    await settle();
    assert.equal((await outcome(again)).reason, 'already_held');
    for (const s of [active, paused, review]) assert.equal((await row(s)).status, s.status, 'adoption writes nothing');
  });

  // ── Promote ─────────────────────────────────────────────────────────

  await t.test('P2 a promote: proposing (status unchanged) until GitHub reports, then in review with everything around it (bugs 9, 12)', async () => {
    defaults();
    const voter = await user();
    const s = await session({ status: 'paused', head: SHA('b') });
    await pool.query('INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2)', [s.app_id, voter.id]);
    // One Home (#6361): a pin no longer joins by itself; the stake is a member's.
    await pool.query(
      "INSERT INTO community_members (community_id, user_id, source) SELECT community_id, $2, 'joined' FROM apps WHERE id = $1 ON CONFLICT DO NOTHING",
      [s.app_id, voter.id]);
    await pool.query(`INSERT INTO notification_preferences (user_id, app_id, category, enabled) VALUES ($1, NULL, 'new_proposals', TRUE)`, [voter.id]);
    // A vote of an earlier review on another head goes.
    await vote(s, voter, 'yes');
    hold(WORK.open);   // GitHub has not answered yet
    const id = await promote(s, { viaAgent: true });
    await rt.drain();
    assert.equal((await outcome(id)).result, 'accepted');
    assert.equal((await instance(s)).state, 'proposing');
    assert.equal((await row(s)).status, 'paused', 'it never reads promoted while GitHub has not readied its pull request (bug 9)');
    assert.equal((await outcome(id)).reply.promoting, 1);
    work.gate.delete(WORK.open);
    // The item that hung is claimed again once its lease lapses: the lease
    // is lapsed in the database rather than by waiting real time out.
    await lapse(s, WORK.open);
    await settle();
    const i = await instance(s);
    assert.equal(i.state, 'in_review');
    assert.deepEqual(i.data.answer, { n: 1, ok: true, prNumber: 77, prUrl: 'https://github.com/acme/x/pull/77', prTitle: 'Make it better' });
    const r = await row(s);
    assert.equal(r.status, 'promoted');
    assert.ok(r.promoted_at);
    assert.equal(r.reviewed_head_sha, SHA('a'), 'the head GitHub read');
    assert.equal(r.active_users_at_promote, 1);
    assert.equal(i.deadline_event.type, 'ReviewCheck');
    assert.equal((await pool.query('SELECT 1 FROM pr_votes WHERE session_id = $1', [s.id])).rowCount, 0, 'the vote on another head went');
    const { rows: lines } = await pool.query(`SELECT content, msg_type FROM chat_messages WHERE thread_type = 'session' AND thread_ref = $1`, [s.id]);
    assert.deepEqual(lines.map((l) => l.msg_type), ['vote']);
    assert.match(lines[0].content, /promoted PR #\d+: Make it better for voting/);
    const { rows: notes } = await pool.query('SELECT user_id, kind FROM notifications WHERE session_id = $1 ORDER BY id', [s.id]);
    // #6402: the vote request no longer goes out at promotion. It waits for
    // the checks to settle passing, which the preview machine's `settled`
    // write triggers (tests/needs-feed-checks-ready-postgres.test.js pins
    // that); only the owner's "your agent put it up" is in this move.
    assert.deepEqual(notes.map((n) => [n.user_id, n.kind]), [[s.owner.id, 'connector_submitted']],
      'the owner\'s "your agent put it up", in the move\'s transaction (bug 12); the vote requests wait for the checks');
    assert.equal((await pool.query(`SELECT 1 FROM events WHERE session_id = $1 AND event_type = 'pr_promoted'`, [s.id])).rowCount, 1);
    const [kick] = await sentTo(s, 'preview');
    assert.equal(kick.type, 'RevisionSubmitted');
    assert.equal(kick.payload.head, SHA('a'), 'the preview machine is asked to check the reviewed head (bug 12)');
    assert.ok(pushed.some((p) => p.data.type === 'session_update' && p.data.action === 'promoted' && p.data.sessionId === s.id));
  });

  await t.test('P3 a promote is refused: not the owner, headless, somebody working on it, a stale read, a merged or draft imported PR (bug 10)', async () => {
    defaults();
    const other = await user();
    const s = await session();
    const reasons = [];
    reasons.push((await outcome(await send(s, 'Promote', { from: 'active', userId: other.id, cap: 5 }, route).then(async (id) => { await settle(); return id; }))).reason);
    const headless = await session({ headless: true });
    reasons.push((await outcome(await promote(headless).then(async (id) => { await settle(); return id; }))).reason);
    const turning = await session();
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"t1"}'::jsonb WHERE id = $1`, [turning.id]);
    reasons.push((await outcome(await promote(turning).then(async (id) => { await settle(); return id; }))).reason);
    // A stale read: one that names a status the proposal is not in (an
    // underway one reads the same, active or paused: review 5).
    reasons.push((await outcome(await promote(s, { from: 'promoted' }).then(async (id) => { await settle(); return id; }))).reason);
    reasons.push((await outcome(await promote(s, { pr: { state: 'closed', merged: true, draft: false, head: SHA('a') } }).then(async (id) => { await settle(); return id; }))).reason);
    const imported = await session({ source: 'imported' });
    reasons.push((await outcome(await promote(imported, { pr: { state: 'open', draft: true, merged: false, head: SHA('a') } }).then(async (id) => { await settle(); return id; }))).reason);
    assert.deepEqual(reasons, ['not_owner', 'headless', 'busy', 'session_state_changed', 'pr_merged', 'pr_draft']);
    assert.equal(calls(WORK.open).length, 0, 'nothing on GitHub moves for a refused promote (bug 8)');
    for (const x of [s, headless, turning, imported]) assert.equal((await row(x)).status, 'active');
  });

  await t.test('P4 the promoted cap is counted under the owner\'s lock: two promotes at once, one wins (bug 11)', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    await session({ owner, appRow: a, status: 'promoted' });
    const one = await session({ owner, appRow: a });
    const two = await session({ owner, appRow: a });
    hold(WORK.open);
    const ids = await Promise.all([promote(one, { cap: 2 }), promote(two, { cap: 2 })]);
    await Promise.all([rt.drain(), rt.drain()]);
    const results = await Promise.all(ids.map(outcome));
    assert.deepEqual(results.map((r) => r.result).sort(), ['accepted', 'rejected']);
    assert.equal(results.find((r) => r.result === 'rejected').reason, 'promoted_cap', 'one going up for a vote counts against the cap');
    work.gate.delete(WORK.open);
    await lapse(one, WORK.open);
    await lapse(two, WORK.open);
    await settle();
  });

  await t.test('P5 GitHub refuses the promote: back to Underway, the answer says why', async () => {
    defaults();
    work.answer.set(WORK.open, () => { throw Object.assign(new Error('no commits on the branch'), { permanent: true, code: 'no_commits' }); });
    const s = await session();
    await promote(s);
    await settle();
    const i = await instance(s);
    assert.equal(i.state, 'underway');
    assert.equal(i.data.slot, 'held', 'it gives back no slot it held');
    assert.equal(i.data.answer.code, 'no_commits');
    assert.equal((await row(s)).status, 'active');
    assert.equal(i.deadline_event.type, 'IdleCheck');
  });

  await t.test('P6 a close while it goes up for a vote: the pull request is closed after GitHub has opened it, never left open (bug 8)', async () => {
    defaults();
    const release = hold(WORK.open);
    const s = await session();
    await promote(s);
    await rt.drain();
    const running = rt.runServices();
    await untilCalled(WORK.open);
    const closeId = await send(s, 'Close', { from: 'active', reason: 'manual', userId: s.owner.id, username: s.owner.username }, route);
    await rt.drain();
    assert.equal((await outcome(closeId)).result, 'accepted');
    assert.equal((await instance(s)).state, 'closed');
    assert.equal((await workOf(s, WORK.close)).length, 0, 'the close waits for the open under way');
    release();
    await running;
    await settle();
    assert.deepEqual(work.calls.filter((c) => c.kind === WORK.open || c.kind === WORK.close).map((c) => c.kind), [WORK.open, WORK.close]);
    assert.equal((await instance(s)).state, 'closed');
    assert.equal((await row(s)).status, 'archived');
    assert.equal((await instance(s)).data.answer.code, 'session_state_changed', 'the promote waiting on it hears it lost');
  });

  // ── Unpromote, pause, resume ────────────────────────────────────────

  await t.test('P7 an unpromote voids the votes; refused while worked on or holding a secret declaration', async () => {
    defaults();
    const s = await session({ status: 'promoted', promotedAgo: 0 });
    const busy = await session({ status: 'promoted', promotedAgo: 0 });
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"t"}'::jsonb WHERE id = $1`, [busy.id]);
    const secret = await session({ status: 'promoted', promotedAgo: 0 });
    await pool.query(
      `INSERT INTO pending_secret_declarations (app_id, session_id, scope, key, declaration, status)
       VALUES ($1, $2, 'app', 'API_KEY', '{}'::jsonb, 'pending')`, [secret.app_id, secret.id]);
    // An unpromote still waits for the shots agent's turn: it would destroy
    // the worker the turn runs in (only a merge does not wait for it).
    const shooting = await session({ status: 'promoted', promotedAgo: 0 });
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"t","mode":"shots"}'::jsonb WHERE id = $1`, [shooting.id]);
    const ids = [];
    for (const x of [s, busy, secret, shooting]) ids.push(await send(x, 'Unpromote', { from: 'promoted', userId: x.owner.id, username: x.owner.username }, route));
    await settle();
    const results = await Promise.all(ids.map(outcome));
    assert.deepEqual(results.map((r) => r.reason), [null, 'busy', 'pending_secret', 'busy']);
    const r = await row(s);
    assert.equal(r.status, 'paused');
    assert.equal(r.approval_epoch, 1);
    assert.equal(calls(WORK.destroy).length, 1);
    const [l] = (await pool.query(`SELECT content FROM chat_messages WHERE thread_ref = $1 AND thread_type = 'session'`, [s.id])).rows;
    assert.match(l.content, /moved PR #\d+: Make it better back to Underway/);
  });

  await t.test('P8 a pause gives the slot back; the platform\'s own never under somebody working on it or a build (bug 20)', async () => {
    defaults();
    const s = await session();
    const worked = await session();
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"t"}'::jsonb WHERE id = $1`, [worked.id]);
    const ids = [
      await send(s, 'Pause', { from: 'active', reason: 'lru' }),
      await send(worked, 'Pause', { from: 'active', reason: 'pressure' }),
      await send(worked, 'Pause', { from: 'active', reason: 'manual', userId: worked.owner.id }, route),
    ];
    await settle();
    assert.deepEqual((await Promise.all(ids.map(outcome))).map((r) => r.reason), [null, 'worked_on', null],
      'the owner\'s own pause is the stop button');
    assert.equal((await row(s)).status, 'paused');
    assert.equal((await instance(s)).deadline_at, null);
    assert.equal((await row(worked)).status, 'paused');
    // A stale read is refused (it read active; it is paused now).
    const stale = await send(s, 'Pause', { from: 'active', reason: 'lru' });
    await settle();
    assert.equal((await outcome(stale)).reason, 'already_paused');
  });

  await t.test('P9 a resume is counted under the caps\' locks: two at once for one slot, one wins; a closed session is never resumed (bugs 11, 21)', async () => {
    defaults();
    const owner = await user();
    const a = await app(owner);
    await session({ owner, appRow: a, status: 'active' });
    const one = await session({ owner, appRow: a, status: 'paused' });
    const two = await session({ owner, appRow: a, status: 'paused' });
    const caps = { user: 2, global: 1000 };
    const ids = await Promise.all([
      send(one, 'Resume', { from: 'paused', userId: owner.id, caps }, route),
      send(two, 'Resume', { from: 'paused', userId: owner.id, caps }, route),
    ]);
    await Promise.all([rt.drain(), rt.drain()]);
    const results = await Promise.all(ids.map(outcome));
    assert.deepEqual(results.map((r) => r.result).sort(), ['accepted', 'rejected']);
    assert.equal(results.find((r) => r.result === 'rejected').reason, 'user_cap');
    const closed = await session({ status: 'archived' });
    await pool.query('UPDATE chat_sessions SET archived_at = NOW() WHERE id = $1', [closed.id]);
    const revive = await send(closed, 'Resume', { from: 'paused', caps: null });
    await settle();
    assert.equal((await outcome(revive)).reason, 'closed', 'bug 21: nothing revives a closed proposal');
    assert.equal((await row(closed)).status, 'archived');
    // The platform-wide cap.
    const lone = await session({ status: 'paused' });
    const g = await send(lone, 'Resume', { from: 'paused', caps: { user: 100, global: 1 } });
    await settle();
    assert.equal((await outcome(g)).reason, 'global_cap');
  });

  await t.test('P10 the idle check pauses a slot nobody used, waits while somebody works on it, and leaves a fixture alone when told', async () => {
    defaults();
    const idle = await session({ lastActivityAgo: 10 * 60 * 1000 });
    const fresh = await session({ lastActivityAgo: 0 });
    const worked = await session({ lastActivityAgo: 10 * 60 * 1000 });
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"t"}'::jsonb WHERE id = $1`, [worked.id]);
    for (const s of [idle, fresh, worked]) await send(s, 'Adopted');
    await settle();
    for (const s of [idle, fresh, worked]) await fire(s);
    assert.equal((await row(idle)).status, 'paused');
    assert.equal((await row(fresh)).status, 'active');
    assert.ok(new Date((await instance(fresh)).deadline_at) > new Date(Date.now() + 4 * 60 * 1000), 're-armed for when it may be idle');
    assert.equal((await row(worked)).status, 'active');
    assert.equal((await instance(worked)).deadline_event.type, 'IdleCheck');
    const fixtures = proposal({ ...DEPS, exemptFixtures: true });
    const rt2 = createRuntime({ pool, machines: [fixtures], pollMs: 50, services: Object.fromEntries(Object.values(WORK).map((k) => [k, fake(k)])) });
    runtimes.push(rt2);
    const fixture = await session({ lastActivityAgo: 10 * 60 * 1000 });
    await pool.query(`UPDATE chat_sessions SET branch_name = 'staging-fixture/x' WHERE id = $1`, [fixture.id]);
    await rt2.append(fixtures, sessionKey(fixture.id), { type: 'Adopted', payload: { sessionId: fixture.id } }, { requestKey: 'fx', source: system });
    await rt2.drain();
    await due(fixture);
    await rt2.fireTimers();
    await rt2.drain();
    assert.equal((await row(fixture)).status, 'active');
  });

  // ── The review check ────────────────────────────────────────────────

  await t.test('P11 voted down: closed by the hourly check, the gate read under the lock (a Yes since counts: bug 3)', async () => {
    defaults();
    const s = await session({ status: 'promoted', promotedAgo: 30 * DAY, approvalsRequired: 3 });
    const keep = await session({ status: 'promoted', promotedAgo: 30 * DAY, approvalsRequired: 3 });
    const [n1, n2, y1, y2] = [await user(), await user(), await user(), await user()];
    for (const x of [s, keep]) { await vote(x, n1, 'no'); await vote(x, n2, 'no'); }
    // The Yes votes land before the check reads the gate.
    await vote(keep, y1, 'yes'); await vote(keep, y2, 'yes');
    for (const x of [s, keep]) { await send(x, 'Adopted'); }
    await settle();
    await fire(s);
    await fire(keep);
    assert.equal((await row(s)).status, 'archived');
    assert.equal((await instance(s)).data.reason, 'auto-rejected');
    assert.match((await pool.query(`SELECT content FROM chat_messages WHERE thread_ref = $1 ORDER BY id DESC LIMIT 1`, [s.id])).rows[0].content,
      /was set aside for now/);
    assert.equal((await row(keep)).status, 'promoted');
    assert.equal((await instance(keep)).deadline_event.type, 'ReviewCheck', 'looked at again in an hour');
  });

  await t.test('P11b an admin\'s lone No sets the change aside after a week, and a Yes stops the clock (#5803)', async () => {
    defaults();
    const admin = await user();
    const other = await user();
    const setAside = await session({ status: 'promoted', promotedAgo: 8 * DAY, approvalsRequired: 3 });
    const voted = await session({ status: 'promoted', promotedAgo: 8 * DAY, approvalsRequired: 3 });
    const notAdmin = await session({ status: 'promoted', promotedAgo: 8 * DAY, approvalsRequired: 3 });
    for (const x of [setAside, voted, notAdmin]) {
      await pool.query('INSERT INTO app_admins (app_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [x.app_id, admin.id]);
    }
    // One No from an admin on each of the first two, a Yes from someone else
    // on the second, and one No from a non-admin on the third. Every No is a
    // week old, so a clock armed from it has already run out.
    for (const x of [setAside, voted]) await vote(x, admin, 'no');
    await vote(voted, other, 'yes');
    await vote(notAdmin, other, 'no');
    for (const x of [setAside, voted, notAdmin]) {
      await pool.query(`UPDATE pr_votes SET created_at = NOW() - interval '8 days' WHERE session_id = $1`, [x.id]);
      await send(x, 'Adopted');
    }
    await settle();
    for (const x of [setAside, voted, notAdmin]) await fire(x);

    assert.equal((await row(setAside)).status, 'archived', 'no Yes, an admin No older than a week');
    assert.equal((await instance(setAside)).data.reason, 'admin-no');
    assert.match((await pool.query(`SELECT content FROM chat_messages WHERE thread_ref = $1 ORDER BY id DESC LIMIT 1`, [setAside.id])).rows[0].content,
      /was set aside: an admin voted No and nobody voted Yes within a week/);
    assert.equal((await row(voted)).status, 'promoted', 'one Yes stops the clock');
    assert.equal((await row(notAdmin)).status, 'promoted', 'a lone No from someone who is not an admin arms nothing');
  });

  await t.test('P11c an approver\'s lone No sets the change aside after two days; only an approver\'s Yes stops it (#5947)', async () => {
    defaults();
    const approver = await user();
    const second = await user();
    const outsider = await user();
    const setAside = await session({ status: 'promoted', promotedAgo: 8 * DAY, approvalsRequired: 1 });
    const approved = await session({ status: 'promoted', promotedAgo: 8 * DAY, approvalsRequired: 1 });
    const recent = await session({ status: 'promoted', promotedAgo: 8 * DAY, approvalsRequired: 1 });
    for (const x of [setAside, approved, recent]) {
      await pool.query(`UPDATE apps SET approver_policy = 'invited' WHERE id = $1`, [x.app_id]);
      for (const p of [approver, second]) {
        await pool.query(`INSERT INTO app_approvers (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [x.app_id, p.id]);
      }
      await vote(x, approver, 'no');
    }
    // An advisory Yes from someone who is not an approver does not stop it.
    await vote(setAside, outsider, 'yes');
    await vote(approved, second, 'yes');
    for (const x of [setAside, approved]) {
      await pool.query(`UPDATE pr_votes SET created_at = NOW() - interval '3 days' WHERE session_id = $1`, [x.id]);
    }
    await pool.query(`UPDATE pr_votes SET created_at = NOW() - interval '1 day' WHERE session_id = $1`, [recent.id]);
    for (const x of [setAside, approved, recent]) await send(x, 'Adopted');
    await settle();
    for (const x of [setAside, approved, recent]) await fire(x);

    assert.equal((await row(setAside)).status, 'archived', 'no approver said Yes within two days of the No');
    assert.equal((await instance(setAside)).data.reason, 'approver-no');
    assert.match((await pool.query(`SELECT content FROM chat_messages WHERE thread_ref = $1 ORDER BY id DESC LIMIT 1`, [setAside.id])).rows[0].content,
      /was set aside: an approver voted No and nobody voted Yes within 2 days/);
    assert.notEqual((await row(approved)).status, 'archived', 'an approver\'s Yes stops the clock');
    assert.equal((await row(recent)).status, 'promoted', 'one day into the two');
  });

  await t.test('P12 gone quiet: warned once, closed three days on, unless somebody voted since the warning (bug 4)', async () => {
    defaults();
    const quiet = await session({ status: 'promoted', promotedAgo: 8 * DAY, approvalsRequired: 3 });
    const revived = await session({ status: 'promoted', promotedAgo: 8 * DAY, approvalsRequired: 3 });
    for (const x of [quiet, revived]) await send(x, 'Adopted');
    await settle();
    await fire(quiet);
    await fire(revived);
    for (const x of [quiet, revived]) {
      assert.ok((await row(x)).stale_notified_at, 'warned');
      assert.equal((await pool.query(`SELECT 1 FROM notifications WHERE session_id = $1 AND kind = 'stale_pr'`, [x.id])).rowCount, 1);
    }
    // Three days pass; one of them hears a vote after its warning.
    for (const x of [quiet, revived]) {
      await asTransition((c) => c.query(`UPDATE chat_sessions SET stale_notified_at = NOW() - interval '4 days' WHERE id = $1`, [x.id]));
    }
    await vote(revived, await user(), 'yes');
    await fire(quiet);
    await fire(revived);
    assert.equal((await row(quiet)).status, 'archived');
    assert.equal((await instance(quiet)).data.reason, 'stale-pr');
    assert.equal((await row(revived)).status, 'promoted', 'a vote since the warning cancels the close');
    assert.equal((await row(revived)).stale_notified_at, null, 'and clears the warning');
  });

  // ── Close and reopen ────────────────────────────────────────────────

  await t.test('P13 every close does the same: votes voided, work orders, the held secret, the bell, the line, the PR, the worker, the preview for good (bugs 7, 14, 15)', async () => {
    defaults();
    const reasons = ['manual', 'auto-rejected', 'stale-pr', 'superseded', 'request-closed', 'red-checks', 'proposal-replaced',
      'bot-failed', 'bench'];
    for (const reason of reasons) {
      const s = await session({ status: 'promoted', promotedAgo: 0 });
      await pool.query('UPDATE chat_sessions SET linked_issues = ARRAY[5] WHERE id = $1', [s.id]);
      const { rows: [task] } = await pool.query(
        `INSERT INTO external_agent_tasks (user_id, app_id, fork_owner, fork_repo, branch_name, base_sha, origin_session_id, status)
         VALUES ($1, $2, 'o', 'r', 'b', $3, $4, 'open') RETURNING id`, [s.owner.id, s.app_id, SHA('0'), s.id]);
      await pool.query(
        `INSERT INTO pending_secret_declarations (app_id, session_id, scope, key, declaration, status, value_enc)
         VALUES ($1, $2, 'app', 'K', '{}'::jsonb, 'pending', 'enc')`, [s.app_id, s.id]);
      const asker = await user();
      await pool.query(`INSERT INTO notifications (user_id, app_id, session_id, kind) VALUES ($1, $2, $3, 'pr_proposed')`, [asker.id, s.app_id, s.id]);
      const id = await send(s, 'Close', { from: 'promoted', reason, userId: reason === 'manual' ? s.owner.id : null, username: s.owner.username },
        reason === 'manual' ? route : system);
      await settle();
      assert.equal((await outcome(id)).result, 'accepted', reason);
      const r = await row(s);
      assert.equal(r.status, 'archived', reason);
      assert.ok(r.archived_at, reason);
      assert.equal(r.approval_epoch, 1, `${reason}: its votes stop counting (Q4, bug 7)`);
      // #6100: why rides the close, and its author hears, unless the close
      // was their own.
      assert.equal(r.close_reason, reason, `${reason}: the close keeps why`);
      const told = (await pool.query(
        `SELECT detail FROM notifications WHERE user_id = $1 AND session_id = $2 AND kind = 'change_closed'`, [s.owner.id, s.id])).rows;
      assert.equal(told.length, reason === 'manual' ? 0 : 1, `${reason}: the author's Closed row`);
      if (told.length) assert.equal(told[0].detail, `event:${id}`, `${reason}: its detail names the event`);
      assert.equal((await pool.query('SELECT status FROM external_agent_tasks WHERE id = $1', [task.id])).rows[0].status, 'abandoned', reason);
      const decl = (await pool.query('SELECT status, value_enc FROM pending_secret_declarations WHERE session_id = $1', [s.id])).rows[0];
      assert.deepEqual([decl.status, decl.value_enc], ['discarded', null], reason);
      assert.equal((await pool.query('SELECT read_at FROM notifications WHERE user_id = $1', [asker.id])).rows[0].read_at !== null, true, `${reason}: the bell stops asking`);
      assert.equal((await pool.query(`SELECT 1 FROM chat_messages WHERE thread_type = 'session' AND thread_ref = $1`, [s.id])).rowCount, 1, reason);
      const kinds = (await workOf(s)).map((w) => w.kind).sort();
      assert.deepEqual(kinds, [WORK.close, WORK.destroy].sort(), reason);
      const [retire] = await sentTo(s, 'preview');
      assert.deepEqual([retire.type, retire.payload.terminal], ['RetireRequested', true], `${reason}: the preview goes for good, built or not (bug 15)`);
      // A withdrawal because its requests closed says so in each request's
      // thread, with the close (the bot's retry cannot lose it: trace-bot-notes bug 11).
      const said = (await pool.query(`SELECT content FROM chat_messages WHERE thread_type = 'issue' AND thread_ref = 5 AND app_id = $1`, [s.app_id])).rows;
      if (reason === 'request-closed') assert.match(said.at(-1)?.content || '', /was withdrawn: this request is closed\.$/, reason);
      else assert.equal(said.length, 0, reason);
      assert.ok(pushed.some((p) => p.data.type === 'issue_update' && p.data.source === 'session_archived' && p.data.appId === s.app_id), reason);
    }
  });

  await t.test('P13b #6100: the Closed row is written once per close, never for Homeroom bot, and follows the author\'s switch', async () => {
    defaults();
    const s = await session({ status: 'promoted', promotedAgo: 0 });
    const id = await send(s, 'Close', { from: 'promoted', reason: 'stale-pr' });
    await settle();
    assert.equal((await outcome(id)).result, 'accepted');
    const rows = async (u, c) => (await pool.query(
      `SELECT 1 FROM notifications WHERE user_id = $1 AND session_id = $2 AND kind = 'change_closed'`, [u.id, c.id])).rowCount;
    assert.equal(await rows(s.owner, s), 1);
    const again = await createChangeClosedNotification(pool, { userId: s.owner.id, appId: s.app_id, sessionId: s.id, eventId: id });
    assert.equal(again.length, 0, 'a retried event doubles nothing');
    const next = await createChangeClosedNotification(pool, { userId: s.owner.id, appId: s.app_id, sessionId: s.id, eventId: `${id}-later` });
    assert.equal(next.length, 1, 'a later close of the same change is news again');
    const own = await createChangeClosedNotification(pool, { userId: s.owner.id, appId: s.app_id, sessionId: s.id, eventId: 'own', byOwner: true });
    assert.equal(own.length, 0, 'nobody is told about a close they made');
    const muted = await createChangeClosedNotification(pool,
      { userId: s.owner.id, appId: s.app_id, sessionId: s.id, eventId: 'muted' }, async () => false);
    assert.equal(muted.length, 0, 'Your proposals switched off');

    const bot = await user({ synthetic: true });
    const b = await session({ status: 'promoted', promotedAgo: 0, owner: bot });
    const bId = await send(b, 'Close', { from: 'promoted', reason: 'stale-pr' });
    await settle();
    assert.equal((await outcome(bId)).result, 'accepted');
    assert.equal((await row(b)).close_reason, 'stale-pr');
    assert.equal(await rows(bot, b), 0, 'a synthetic author gets no bell row');
  });

  await t.test('P14 a close a newer move overtook is refused; merging and merged are past closing', async () => {
    defaults();
    const s = await session({ status: 'promoted', promotedAgo: 0 });
    await send(s, 'Unpromote', { from: 'promoted', userId: s.owner.id }, route);
    await settle();
    const late = await send(s, 'Close', { from: 'promoted', reason: 'auto-rejected' });
    await settle();
    assert.equal((await outcome(late)).reason, 'overtaken');
    assert.equal((await row(s)).status, 'paused');
    const m = await session({ status: 'merging' });
    const refused = await send(m, 'Close', { from: 'merging', reason: 'manual' });
    await settle();
    assert.equal((await outcome(refused)).reason, 'merging');
  });

  await t.test('P15 a reopen during the close: the PR is reopened after the close reports, and stays open (bug 17)', async () => {
    defaults();
    const release = hold(WORK.close);
    const s = await session({ status: 'paused' });
    await send(s, 'Close', { from: 'paused', reason: 'manual', userId: s.owner.id }, route);
    await rt.drain();
    const running = rt.runServices();
    await untilCalled(WORK.close);
    // The close's worker destroy runs ungated: it must have reported and been
    // settled before the reopen is read, or the reopen would hear teardown.
    await untilSettled(s, WORK.destroy);
    const reopen = await send(s, 'Reopen', { from: 'archived', userId: s.owner.id }, route);
    await rt.drain();
    assert.equal((await outcome(reopen)).result, 'accepted');
    assert.equal((await row(s)).status, 'paused');
    assert.equal((await row(s)).archived_at, null);
    assert.equal((await row(s)).close_reason, null, '#6100: a reopen clears why it was closed');
    assert.equal((await workOf(s, WORK.reopen)).length, 0, 'the reopen waits for the close under way');
    release();
    await running;
    await settle();
    assert.deepEqual(work.calls.filter((c) => [WORK.close, WORK.reopen].includes(c.kind)).map((c) => c.kind), [WORK.close, WORK.reopen]);
    // GitHub says the PR is closed for good: the row forgets it.
    const gone = await session({ status: 'archived' });
    await pool.query('UPDATE chat_sessions SET archived_at = NOW() WHERE id = $1', [gone.id]);
    work.answer.set(WORK.reopen, (input) => ({ cleared: true, prNumber: input.number }));
    await send(gone, 'Reopen', { from: 'archived', userId: gone.owner.id }, route);
    await settle();
    assert.equal((await row(gone)).pr_number, null);
  });

  // ── The merge ───────────────────────────────────────────────────────
  // The claim under the lock, a declined attempt and a pull request closed
  // for good are the merge queue's path (tests/workflow-merge-postgres.test.js
  // M2, M6).

  await t.test('P19 merged by merge-followups: the proposal hears it, and never writes over it', async () => {
    defaults();
    const s = await session({ status: 'promoted', promotedAgo: 0 });
    await send(s, 'Adopted');
    await settle();
    // merge-followups' move, with its marker.
    await asTransition((c) => c.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() WHERE id = $1`, [s.id]));
    // An event that lands before the message reads the row merged.
    const timer = await send(s, 'Unpromote', { from: 'promoted', userId: s.owner.id }, route);
    await settle();
    assert.equal((await outcome(timer)).reason, 'merged');
    await send(s, 'Merged', {}, fromMerge);
    await settle();
    assert.equal((await instance(s)).state, 'merged');
    assert.equal((await row(s)).status, 'merged');
    const after = await send(s, 'Close', { from: 'merged', reason: 'manual' });
    await settle();
    assert.equal((await outcome(after)).reason, 'merged');
  });

  // ── The review revision (Q3) ────────────────────────────────────────

  await t.test('P20 the reviewed head moves through the machine: from what its caller read; never on a closed or merged proposal (bug 6)', async () => {
    defaults();
    const s = await session({ status: 'promoted', promotedAgo: 0 });
    await pool.query(`UPDATE chat_sessions SET shots_state = 'verified' WHERE id = $1`, [s.id]);
    const moved = await send(s, 'ReviewHeadMoved', { column: 'reviewed', from: SHA('a'), to: SHA('b'), keepVotes: false });
    const kept = await send(s, 'ReviewHeadMoved', { column: 'reviewed', from: SHA('b'), to: SHA('c'), keepVotes: true });
    const stale = await send(s, 'ReviewHeadMoved', { column: 'reviewed', from: SHA('a'), to: SHA('d'), keepVotes: false });
    await settle();
    assert.deepEqual([(await outcome(moved)).reply.epoch, (await outcome(kept)).reply.epoch], [1, 1]);
    assert.equal((await outcome(stale)).reason, 'head_moved');
    assert.equal((await row(s)).reviewed_head_sha, SHA('c'));
    const told = await sentTo(s, 'shots');
    assert.deepEqual(told.map((m) => [m.type, m.payload.head, m.payload.pin]), [['HeadMoved', SHA('b'), 'reviewed'], ['HeadMoved', SHA('c'), 'reviewed']]);
    const closed = await session({ status: 'archived' });
    await pool.query('UPDATE chat_sessions SET archived_at = NOW() WHERE id = $1', [closed.id]);
    const late = await send(closed, 'ReviewHeadMoved', { column: 'reviewed', from: SHA('a'), to: SHA('b'), keepVotes: false });
    const cleared = await send(closed, 'ApprovalsCleared', { reason: 'x' });
    await settle();
    assert.deepEqual([(await outcome(late)).reason, (await outcome(cleared)).reason], ['closed', 'closed']);
    assert.equal((await row(closed)).approval_epoch, 0, 'a closed proposal\'s votes are a record');
  });

  // ── What the caller read, and the guard ─────────────────────────────

  await t.test('P20b an authored push ends an admin force and records what it was; a mechanical move keeps it', async () => {
    defaults();
    const s = await session({ status: 'promoted', promotedAgo: 0 });
    await pool.query(`UPDATE chat_sessions SET shots_state = 'verified' WHERE id = $1`, [s.id]);
    await send(s, 'ForceMerge', { from: 'promoted', username: 'evan', userId: 7 }, route);
    await settle();
    let inst = await instance(s);
    assert.equal(inst.data.force.by, 'evan');
    assert.equal(inst.data.force.head, SHA('a'));

    // A mechanical move of main carries the force, and its head, with it.
    await send(s, 'ReviewHeadMoved', { column: 'reviewed', from: SHA('a'), to: SHA('b'), keepVotes: true, reason: 'mechanical' });
    await settle();
    inst = await instance(s);
    assert.equal(inst.data.force.head, SHA('b'), 'a mechanical move follows the force');
    assert.equal(inst.data.forceDropped, null);

    // The author's own push ends it, and the record of what it was survives
    // so the card and the thread can say it no longer applies.
    await send(s, 'ReviewHeadMoved', { column: 'reviewed', from: SHA('b'), to: SHA('c'), keepVotes: false, reason: 'authored' });
    await settle();
    inst = await instance(s);
    assert.equal(inst.data.force, null);
    assert.equal(inst.data.forceDropped.by, 'evan');
    assert.equal(inst.data.forceDropped.head, SHA('b'));
    assert.equal(inst.data.forceDropped.to, SHA('c'));
    const { rows: lines } = await pool.query(
      `SELECT content FROM chat_messages WHERE thread_type = 'session' AND thread_ref = $1
         AND content ILIKE '%admin merge by evan%'`, [s.id]);
    assert.equal(lines.length, 1, 'the change\'s thread says the force no longer applies');

    // A new force clears the dropped record.
    await send(s, 'ForceMerge', { from: 'promoted', username: 'evan', userId: 7 }, route);
    await settle();
    inst = await instance(s);
    assert.ok(inst.data.force);
    assert.equal(inst.data.forceDropped, null);
  });

  await t.test('P21 every status move names what its caller read: a payload without `from` is refused at the append', async () => {
    const s = await session();
    for (const type of ['Promote', 'Unpromote', 'Pause', 'Resume', 'Close', 'Reopen', 'ReviewHeadMoved']) {
      await assert.rejects(rt.append(machine, sessionKey(s.id), { type, payload: { sessionId: s.id, userId: s.owner.id, reason: 'manual', cap: 1,
        column: 'reviewed', to: SHA('b') } }, { requestKey: `nofrom-${type}`, source: route }), /from/, type);
    }
  });

  await t.test('P22 the ownership guard refuses a raw write to a proposal the machine holds; the move into merged is merge-followups\'', async () => {
    const s = await session({ status: 'active' });
    await send(s, 'Adopted');
    await settle();
    for (const sql of [
      `UPDATE chat_sessions SET status = 'archived' WHERE id = $1`,
      `UPDATE chat_sessions SET approval_epoch = approval_epoch + 1 WHERE id = $1`,
      `UPDATE chat_sessions SET reviewed_head_sha = '${SHA('f')}' WHERE id = $1`,
      `UPDATE chat_sessions SET stale_notified_at = NOW() WHERE id = $1`,
      `UPDATE chat_sessions SET promoted_at = NOW() WHERE id = $1`,
    ]) {
      await assert.rejects(pool.query(sql, [s.id]), /WF_OWNERSHIP_VIOLATION/, sql);
    }
    const free = await session({ status: 'active' });
    await pool.query(`UPDATE chat_sessions SET status = 'paused' WHERE id = $1`, [free.id]);
    assert.equal((await row(free)).status, 'paused', 'a row nobody holds is the next event\'s to adopt as it is');
    await assert.rejects(pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [free.id]), /WF_OWNERSHIP_VIOLATION/,
      'only merge-followups moves a proposal into merged');
  });

  await t.test('P23 an imported proposal\'s vote takes the row lock and needs review (bug 5)', async () => {
    const votes = require('../src/routes/votes');
    const s = await session({ status: 'active', source: 'imported' });
    const u = await user();
    const r = await votes.recordVote({ pool, session: s, userId: u.id, vote: 'yes', headSha: SHA('a'), revisionEnforced: false });
    assert.equal(r.rowCount, 0, 'no vote on a proposal that is not up for one');
    await asTransition((c) => c.query(`UPDATE chat_sessions SET status = 'promoted' WHERE id = $1`, [s.id]));
    const ok = await votes.recordVote({ pool, session: s, userId: u.id, vote: 'yes', headSha: SHA('a'), revisionEnforced: false });
    assert.equal(ok.rowCount, 1);
  });

  // ── After the adversarial review (design §9.1) ──────────────────────

  const ofKey = (s, kind) => work.calls.filter((c) => c.kind === kind && c.input.sessionId === s.id);

  await t.test('P24 a close while a proposal with no pull request yet goes up: the PR GitHub then opens is closed, by the number it has by then (review 1)', async () => {
    defaults();
    const release = hold(WORK.open);
    const s = await session({ pr: false });
    await promote(s);
    await rt.drain();
    const running = rt.runServices();
    await untilCalled(WORK.open);
    const closeId = await send(s, 'Close', { from: 'active', reason: 'manual', userId: s.owner.id }, route);
    await rt.drain();
    assert.equal((await outcome(closeId)).result, 'accepted');
    assert.equal((await workOf(s, WORK.close)).length, 0, 'the close waits for the open under way');
    release();
    await running;
    await settle();
    const [closed] = ofKey(s, WORK.close);
    assert.ok(closed, 'the pull request opened after the close is closed');
    assert.equal(closed.input.number, null, 'its number is read when the close runs (pr.close resolves it from the row)');
    assert.equal(closed.input.repo, s.app.slug);
  });

  await t.test('P25 a worker destroy (and a CC purge) still owed is cancelled by the move that brings the session back (review 2)', async () => {
    defaults();
    const s = await session();
    await send(s, 'Pause', { from: 'active', reason: 'manual', userId: s.owner.id }, route);
    await rt.drain();
    assert.deepEqual((await instance(s)).data.doomed.map((d) => d.kind), [WORK.destroy]);
    await send(s, 'Resume', { from: 'paused', userId: s.owner.id, caps: { user: 100, global: 100 } }, route);
    await settle();
    assert.equal(ofKey(s, WORK.destroy).length, 0, 'a resumed session\'s worker is never destroyed by the pause before it');
    assert.deepEqual((await instance(s)).data.doomed, []);
    // A close with its CC volume purged, then a reopen before either ran.
    const c = await session({ status: 'paused' });
    await send(c, 'Close', { from: 'paused', reason: 'manual', userId: c.owner.id, purgeCc: true }, route);
    await rt.drain();
    await send(c, 'Reopen', { from: 'archived', userId: c.owner.id }, route);
    await settle();
    assert.equal(ofKey(c, WORK.destroy).length + ofKey(c, WORK.purge).length, 0);
    assert.equal((await row(c)).cc_purged, false);
    // One that ran is done: it reports and leaves the list.
    const p = await session();
    await send(p, 'Pause', { from: 'active', reason: 'manual', userId: p.owner.id }, route);
    await settle();
    assert.equal(ofKey(p, WORK.destroy).length, 1);
    assert.deepEqual((await instance(p)).data.doomed, []);
  });

  await t.test('P26 a move its caller stopped waiting for is refused once past its deadline, never applied late (review 4)', async () => {
    defaults();
    const past = new Date(Date.now() - 1000).toISOString();
    const s = await session({ status: 'promoted', promotedAgo: 0 });
    const headLate = await send(s, 'ReviewHeadMoved', { column: 'reviewed', from: SHA('a'), to: SHA('b'), keepVotes: false, deadline: past });
    const unpromoteLate = await send(s, 'Unpromote', { from: 'promoted', userId: s.owner.id, deadline: past }, route);
    const u = await session();
    const pauseLate = await send(u, 'Pause', { from: 'active', reason: 'lru', deadline: past });
    await settle();
    for (const id of [headLate, unpromoteLate, pauseLate]) assert.equal((await outcome(id)).reason, 'expired');
    assert.equal((await row(s)).status, 'promoted');
    assert.equal((await row(s)).reviewed_head_sha, SHA('a'));
    assert.equal((await row(u)).status, 'active');
    const inTime = await send(s, 'ReviewHeadMoved', { column: 'reviewed', from: SHA('a'), to: SHA('b'), keepVotes: false,
      deadline: new Date(Date.now() + 60000).toISOString() });
    await settle();
    assert.equal((await outcome(inTime)).result, 'accepted');
    assert.equal((await row(s)).reviewed_head_sha, SHA('b'));
  });

  await t.test('P27 a close names the proposal underway whichever slot it read: an idle pause between the read and the close does not lose it (review 5)', async () => {
    defaults();
    const s = await session();
    await send(s, 'Pause', { from: 'active', reason: 'auto-idle' });
    await settle();
    assert.equal((await row(s)).status, 'paused');
    const closeId = await send(s, 'Close', { from: 'active', reason: 'proposal-replaced' });
    await settle();
    assert.equal((await outcome(closeId)).result, 'accepted');
    assert.equal((await row(s)).status, 'archived');
    // A promote likewise.
    const p = await session({ status: 'paused' });
    const id = await promote(p, { from: 'active' });
    await settle();
    assert.equal((await outcome(id)).result, 'accepted');
  });

  await t.test('P28 a PR closed for good is forgotten even when a promote follows the reopen at once (review 6)', async () => {
    defaults();
    const release = hold(WORK.close);
    const s = await session({ status: 'paused' });
    const dead = s.pr_number;
    await send(s, 'Close', { from: 'paused', reason: 'manual', userId: s.owner.id }, route);
    await rt.drain();
    const running = rt.runServices();
    await untilCalled(WORK.close);
    await untilSettled(s, WORK.destroy);
    await send(s, 'Reopen', { from: 'archived', userId: s.owner.id }, route);
    await rt.drain();
    work.answer.set(WORK.reopen, (input) => ({ cleared: true, prNumber: input.number }));
    let seen;
    work.answer.set(WORK.open, async () => { seen = (await row(s)).pr_number; return { head: SHA('a'), prNumber: 78 }; });
    const id = await promote({ ...s, status: 'paused' });
    await rt.drain();
    assert.equal((await outcome(id)).result, 'accepted');
    release();
    await running;
    await settle();
    assert.deepEqual(ofKey(s, WORK.close).concat(ofKey(s, WORK.reopen), ofKey(s, WORK.open)).map((c) => c.kind),
      [WORK.close, WORK.reopen, WORK.open], 'the queued reopen is kept, then the open runs');
    assert.notEqual(dead, null);
    assert.equal(seen, null, 'the open finds no dead PR on the row, so it opens a fresh one');
    assert.equal((await instance(s)).state, 'in_review');
  });

  await t.test('P29 a head a reconcile installed while it went up stands over the one GitHub read before (review 7)', async () => {
    defaults();
    const release = hold(WORK.open);
    const s = await session({ status: 'paused' });
    await promote(s);
    await rt.drain();
    const running = rt.runServices();
    await untilCalled(WORK.open);
    const moved = await send(s, 'ReviewHeadMoved', { column: 'reviewed', from: SHA('a'), to: SHA('b'), keepVotes: false });
    await rt.drain();
    assert.equal((await outcome(moved)).result, 'accepted');
    release();
    await running;
    await settle();
    assert.equal((await row(s)).status, 'promoted');
    assert.equal((await row(s)).reviewed_head_sha, SHA('b'), 'the push stands');
    const kicks = (await sentTo(s, 'preview')).filter((m) => m.type === 'RevisionSubmitted' && m.payload.trigger === 'promote-kick');
    assert.deepEqual(kicks.map((k) => k.payload.head), [SHA('b')]);
  });

  await t.test('P30 a cap configured as zero refuses the move; it is never a bad payload (review 10)', async () => {
    defaults();
    const s = await session();
    const id = await promote(s, { cap: 0 });
    const p = await session({ status: 'paused' });
    const r = await send(p, 'Resume', { from: 'paused', userId: p.owner.id, caps: { user: 0, global: 100 } }, route);
    await settle();
    assert.equal((await outcome(id)).reason, 'promoted_cap');
    assert.equal((await outcome(r)).reason, 'user_cap');
  });

  await t.test('P31 the real handlers: a close resolves the PR number GitHub gave since; a destroy spares a held session; a purge spares a reopened one (review 1, 2)', async (tt) => {
    const { proposalServices } = require('../src/workflow/proposal/services.ts');
    const github = require('../src/services/github');
    const worker = require('../src/services/worker');
    const seen = [];
    const saved = new Map([[github, ['isEnabled', 'closePR']], [worker, ['removeWorker', 'removeCcVolume']]]);
    const restore = [];
    for (const [mod, names] of saved) for (const n of names) restore.push([mod, n, mod[n]]);
    tt.after(() => { for (const [mod, n, fn] of restore) mod[n] = fn; });
    github.isEnabled = () => true;
    github.closePR = async (owner, repo, number) => { seen.push(['closePR', number]); };
    // The runtime's removal as worker.js does it: it asks to proceed first.
    worker.removeWorker = async (id, o) => {
      if (!(await o.proceed())) return { skipped: true };
      seen.push(['removeWorker', id]);
      return { removed: true };
    };
    worker.removeCcVolume = async (id, o) => {
      if (!(await o.proceed())) return { skipped: true };
      seen.push(['removeCcVolume', id]);
      return { removed: true };
    };
    const svc = proposalServices({ config: {}, pool });
    let claimLost = false;
    const run = (kind, input) => svc[kind].run({ input, key: 'k', attempt: 1,
      checkpoint: async () => { if (claimLost) throw new Error('lease lost'); } });

    // Closed while GitHub opened it: the number is the one the row has now.
    const s = await session({ pr: false });
    assert.deepEqual(await run(WORK.close, { sessionId: s.id, owner: 'acme', repo: s.app.slug, number: null }), { none: true });
    await pool.query('UPDATE chat_sessions SET pr_number = 91 WHERE id = $1', [s.id]);
    assert.deepEqual(await run(WORK.close, { sessionId: s.id, owner: 'acme', repo: s.app.slug, number: null }), { closed: true });

    // A destroy claimed before the resume that cancelled it.
    const held = await session();
    await send(held, 'Adopted');
    await settle();
    assert.deepEqual(await run(WORK.destroy, { sessionId: held.id }), { skipped: 'held' });
    const paused = await session({ status: 'paused' });
    await send(paused, 'Adopted');
    await settle();
    assert.deepEqual(await run(WORK.destroy, { sessionId: paused.id }), { destroyed: true });

    // A purge claimed before the reopen that cancelled it.
    assert.deepEqual(await run(WORK.purge, { sessionId: paused.id }), { skipped: 'reopened' });
    const gone = await session({ status: 'archived' });
    await pool.query('UPDATE chat_sessions SET archived_at = NOW() WHERE id = $1', [gone.id]);
    await send(gone, 'Adopted');
    await settle();
    assert.deepEqual(await run(WORK.purge, { sessionId: gone.id }), { purged: true });
    assert.deepEqual(seen.map((x) => x[0]), ['closePR', 'removeWorker', 'removeCcVolume']);
    assert.equal(seen[0][1], 91);

    // A removal the runtime refused fails the attempt (it is tried again);
    // it never reports a worker destroyed that is still there (review 2.2).
    worker.removeWorker = async () => { throw new Error('kubernetes unavailable'); };
    await assert.rejects(run(WORK.destroy, { sessionId: paused.id }), /kubernetes unavailable/);

    // Fenced (second review): a claim lost before the removal removes
    // nothing; nor does a session that came back between the handler's
    // first look and the removal.
    worker.removeWorker = async (id, o) => {
      if (!(await o.proceed())) return { skipped: true };
      seen.push(['removeWorker', id]);
      return { removed: true };
    };
    const before = seen.length;
    claimLost = true;
    await assert.rejects(run(WORK.destroy, { sessionId: paused.id }), /lease lost/);
    claimLost = false;
    const racing = worker.removeWorker;
    worker.removeWorker = async (id, o) => {
      await asTransition((c) => c.query(
        `UPDATE wf_instances SET data = jsonb_set(data, '{slot}', '"held"') WHERE machine = $1 AND key = $2`, [MACHINE, sessionKey(id)]));
      return racing(id, o);
    };
    assert.deepEqual(await run(WORK.destroy, { sessionId: paused.id }), { skipped: 'held' });
    assert.equal(seen.length, before, 'nothing removed');
  });

  await t.test('P33 a lapsed lease or an attempt that failed does not end teardown: a resume or a reopen still waits (second review)', async () => {
    defaults();
    // The worker's destroy claimed by a process that stalled in its call.
    const release = hold(WORK.destroy);
    const s = await session();
    await send(s, 'Pause', { from: 'active', reason: 'manual', userId: s.owner.id }, route);
    await rt.drain();
    const running = rt.runServices();
    await untilCalled(WORK.destroy);
    await lapse(s, WORK.destroy);
    const resume = await send(s, 'Resume', { from: 'paused', userId: s.owner.id, caps: { user: 100, global: 100 } }, route);
    await rt.drain();
    assert.equal((await outcome(resume)).reason, 'tearing_down', 'a lapsed lease does not prove the call stopped');
    // Its attempt failed and waits to be tried again: it may have asked for
    // the removal already.
    await pool.query(
      `UPDATE wf_work SET status = 'queued', claim_id = NULL, lease_until = NULL, due_at = now() + interval '1 hour'
        WHERE machine = $1 AND key = $2 AND kind = $3`, [MACHINE, sessionKey(s.id), WORK.destroy]);
    const again = await send(s, 'Resume', { from: 'paused', userId: s.owner.id, caps: { user: 100, global: 100 } }, route);
    await rt.drain();
    assert.equal((await outcome(again)).reason, 'tearing_down');
    assert.equal((await row(s)).status, 'paused');
    release();
    await running.catch(() => {});

    // The CC volume's purge, its lease lapsed mid-call: the reopen waits,
    // and the memory is never reported kept while it goes.
    defaults();
    work.answer.set(WORK.purge, { purged: true });
    const purged = hold(WORK.purge);
    const c = await session({ status: 'paused', pr: false });
    await send(c, 'Close', { from: 'paused', reason: 'manual', userId: c.owner.id, purgeCc: true }, route);
    await rt.drain();
    const purging = rt.runServices();
    await untilCalled(WORK.purge);
    await lapse(c, WORK.purge);
    const reopen = await send(c, 'Reopen', { from: 'archived', userId: c.owner.id }, route);
    await rt.drain();
    assert.equal((await outcome(reopen)).reason, 'tearing_down');
    assert.equal((await row(c)).status, 'archived');
    purged();
    await purging.catch(() => {});
  });

  await t.test('P32 a resume or a reopen waits for teardown already under way, never races it (review 2.1)', async () => {
    defaults();
    // The worker of the pause is being destroyed when its owner comes back.
    const release = hold(WORK.destroy);
    const s = await session();
    await send(s, 'Pause', { from: 'active', reason: 'manual', userId: s.owner.id }, route);
    await rt.drain();
    const running = rt.runServices();
    await untilCalled(WORK.destroy);
    assert.equal(ofKey(s, WORK.destroy).length, 1, 'the destroy is under way');
    const early = await send(s, 'Resume', { from: 'paused', userId: s.owner.id, caps: { user: 100, global: 100 } }, route);
    await rt.drain();
    assert.equal((await outcome(early)).reason, 'tearing_down');
    assert.equal((await row(s)).status, 'paused');
    release();
    await running;
    await settle();
    const late = await send(s, 'Resume', { from: 'paused', userId: s.owner.id, caps: { user: 100, global: 100 } }, route);
    await settle();
    assert.equal((await outcome(late)).result, 'accepted', 'once the destroy reported, the session comes back');
    assert.equal((await row(s)).status, 'active');

    // A reopen while the CC volume is being purged: the purge finishes and
    // records itself, then the reopen goes ahead.
    defaults();
    work.answer.set(WORK.purge, { purged: true });
    const purged = hold(WORK.purge);
    const c = await session({ status: 'paused', pr: false });
    await send(c, 'Close', { from: 'paused', reason: 'manual', userId: c.owner.id, purgeCc: true }, route);
    await rt.drain();
    const purging = rt.runServices();
    await untilCalled(WORK.purge);
    const reopenEarly = await send(c, 'Reopen', { from: 'archived', userId: c.owner.id }, route);
    await rt.drain();
    assert.equal((await outcome(reopenEarly)).reason, 'tearing_down');
    purged();
    await purging;
    await settle();
    assert.equal((await row(c)).cc_purged, true, 'the purge that ran is recorded');
    const reopen = await send(c, 'Reopen', { from: 'archived', userId: c.owner.id }, route);
    await settle();
    assert.equal((await outcome(reopen)).result, 'accepted');
    assert.equal((await row(c)).cc_purged, true, 'a reopened session says its memory went');
  });

  // A hosted build's diagram reaches the pull request as a GitHub move of the
  // proposal's (pr.diagram), owed by the write that stored it: it was a call
  // nobody waited for after the response, lost to a restart.
  await t.test('P35 GitHub\'s word on its pull request, as a look read it: a merge while up for its vote is recorded, merged before it or closed once the close stood closes it, one being merged is left to its attempt', async () => {
    defaults();
    const instance = async (x) => (await pool.query('SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(x.id)])).rows[0];
    // Up for its vote, merged on GitHub: a merge, merge-followups told with
    // the tally the look read.
    const s = await session({ status: 'promoted', promotedAgo: 0 });
    const tally = { yes: 2, required: 3, active: 4 };
    const merged = await send(s, 'PrLooked', { from: 'promoted', merged: true, closed: true, baseRead: true, mergeSha: 'c'.repeat(40),
      mergedAt: '2026-10-21T10:00:00Z', closedAt: '2026-10-21T10:00:00Z', tally });
    await settle();
    assert.equal((await outcome(merged)).result, 'accepted');
    assert.equal((await instance(s)).state, 'merging');
    const { rows: [told] } = await pool.query(
      `SELECT payload FROM wf_events WHERE machine = 'merge-followups' AND key = $1 AND type = 'Merged'`, [sessionKey(s.id)]);
    assert.deepEqual([told.payload.tally, told.payload.observedBy, told.payload.mergeSha], [tally, 'recovery', 'c'.repeat(40)]);

    // Closed on GitHub: not while the close may still be undone (an author
    // re-running CI), then closed.
    const a = await session({ status: 'active' });
    const now = () => new Date().toISOString();
    const early = await send(a, 'PrLooked', { from: 'active', merged: false, closed: true, closedAt: new Date(Date.now() - 60000).toISOString(), readAt: now() });
    await settle();
    assert.equal((await outcome(early)).reason, 'settling');
    assert.equal((await row(a)).status, 'active');
    // A close read long ago (refused during a rollout, asked again since)
    // may predate a reopen: refused, the next look reads GitHub anew.
    const old = await send(a, 'PrLooked', { from: 'active', merged: false, closed: true,
      closedAt: new Date(Date.now() - 3600000).toISOString(), readAt: new Date(Date.now() - 40 * 60000).toISOString() });
    await settle();
    assert.equal((await outcome(old)).reason, 'stale');
    assert.equal((await row(a)).status, 'active');
    await send(a, 'PrLooked', { from: 'active', merged: false, closed: true, closedAt: new Date(Date.now() - 600000).toISOString(), readAt: now() });
    await settle();
    assert.equal((await row(a)).status, 'archived');
    assert.equal((await instance(a)).data.reason, 'pr-closed');
    // A merge read by an older release's look, which did not read where it
    // went: left for the next look (src/workflow/rules/pr-base.ts).
    const unread = await session({ status: 'promoted', promotedAgo: 0 });
    const blind = await send(unread, 'PrLooked', { from: 'promoted', merged: true, closed: true });
    await settle();
    assert.equal((await outcome(blind)).reason, 'base_unread');
    assert.equal((await row(unread)).status, 'promoted');
    // Merged before it went up for a vote: closed, as merged on GitHub.
    const b = await session({ status: 'active' });
    await send(b, 'PrLooked', { from: 'active', merged: true, closed: true, baseRead: true });
    await settle();
    assert.equal((await instance(b)).data.reason, 'pr-merged');

    // Being merged: its attempt's to settle. Still open, a stale reading,
    // or anyone but the system: nothing.
    const m = await session({ status: 'merging' });
    const left = await send(m, 'PrLooked', { from: 'merging', merged: true, closed: true, baseRead: true });
    const o = await session({ status: 'promoted', promotedAgo: 0 });
    const open = await send(o, 'PrLooked', { from: 'promoted', merged: false, closed: false });
    const stale = await send(o, 'PrLooked', { from: 'active', merged: true, closed: true, baseRead: true });
    const byRoute = await send(o, 'PrLooked', { from: 'promoted', merged: true, closed: true, baseRead: true }, route);
    await settle();
    assert.deepEqual([(await outcome(left)).reason, (await outcome(open)).reason, (await outcome(stale)).reason, (await outcome(byRoute)).reason],
      ['merging', 'open', 'overtaken', 'internal_only']);
    assert.equal((await row(o)).status, 'promoted');
  });

  await t.test('P34 a stored diagram owes its pull request the block, one GitHub move at a time, the newest waiting', async () => {
    defaults();
    const store = (s) => pool.connect().then(async (c) => {
      try {
        await c.query('BEGIN');
        await c.query(`UPDATE chat_sessions SET pr_diagram = '{"kind":"rename"}'::jsonb WHERE id = $1`, [s.id]);
        await platform.diagramStored(c, { sessionId: s.id, appId: s.app_id });
        await c.query('COMMIT');
      } finally { c.release(); }
    });
    const s = await session({ status: 'promoted' });
    await store(s);
    await settle();
    assert.deepEqual(calls(WORK.diagram).map((c) => c.input.sessionId), [s.id]);
    // While a GitHub move runs, diagrams wait behind it, and a newer one
    // replaces one still waiting.
    let release;
    work.gate.set(WORK.diagram, new Promise((r) => { release = r; }));
    await store(s);
    await rt.drain();
    const running = rt.runServices();
    await untilCalled(WORK.diagram, 2);
    try {
      await store(s);
      await store(s);
      await rt.drain();
      assert.equal((await instance(s)).data.pr.next.filter((w) => w.kind === WORK.diagram).length, 1, 'the newest waits, once');
    } finally {
      release();
      await running;
    }
    work.gate.clear();
    await settle();
    assert.equal(calls(WORK.diagram).length, 3);
    assert.equal((await instance(s)).data.pr.running, null);
    // None for an imported proposal (its body is its author's), or one with
    // no pull request yet (its open writes the block).
    const imported = await session({ status: 'promoted', source: 'imported' });
    const bare = await session({ pr: false });
    await store(imported);
    await store(bare);
    await settle();
    assert.equal(calls(WORK.diagram).length, 3);
  });
});
