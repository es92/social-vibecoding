'use strict';

// The Homeroom bot's change machine (step 8, src/workflow/bot-change/)
// against the full PostgreSQL schema: what one of the bot's changes up for a
// vote has its requester and approvers hear, and when it goes back to the
// bot, decided under the instance's lock from the change's row, with the
// work that sends it fake. Each [main] bug the step fixes
// (workflow-foundation's trace-bot-notes.md §7) is named where it is pinned.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/workflow-bot-change-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime, defineMachine } = require('../src/workflow/kernel/index.ts');
const { botChange, sessionKey, MACHINE, WORK, FIX_ROUNDS } = require('../src/workflow/bot-change/machine.ts');
const { toBotChange, writeBotChange } = require('../src/workflow/rules/bot-notes.ts');
const { READY_HOLD_MS } = require('../src/workflow/rules/bot-readiness.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);

test('the Homeroom bot\'s change machine against the full PostgreSQL schema', { timeout: 240000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_botchange_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  const { rows: [bot] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id`);
  const { rows: [asker] } = await pool.query(`INSERT INTO users (username, password) VALUES ('asker', 'x') RETURNING id`);
  const { rows: [person] } = await pool.query(`INSERT INTO users (username, password) VALUES ('person', 'x') RETURNING id`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, repo_url, status) VALUES ('Clubs', 'clubs', $1, 'https://github.com/acme/clubs', 'running') RETURNING *`,
    [asker.id]);
  const asTransition = async (fn) => {
    const cl = await pool.connect();
    try {
      await cl.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`); await fn(cl); await cl.query('COMMIT');
    } catch (err) {
      // A connection is never handed back mid-transaction (the next test's
      // query on it would fail for this one's mistake).
      await cl.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { cl.release(); }
  };
  // One of the bot's changes up for a vote, for request #n, its run, and
  // who asked for it. `owner`: somebody else's change instead.
  async function change({ owner = bot.id, status = 'promoted', head = SHA('a'), run = true } = {}) {
    const n = ++seq;
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, reviewed_head_sha, checks_commit_sha, linked_issues, pr_title, pr_number, approval_epoch)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, 1) RETURNING *`,
      [app.id, owner, status, head, [n], `Change ${n}`, 100 + n]);
    if (run) {
      await pool.query(
        `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id) VALUES ($1, $2, 'live', 'ready', $3)`,
        [app.id, n, s.id]);
      await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, $2, $3)', [app.id, n, asker.id]);
    }
    return { ...s, issueNumber: n, head };
  }
  // The checks' verdict on its head, as the preview machine leaves it.
  const verdict = (s, state, results = []) => asTransition((cl) => cl.query(
    `UPDATE chat_sessions SET check_state = $2, checks_checked_at = NOW(), test_results = $3::jsonb WHERE id = $1`,
    [s.id, state, JSON.stringify(results)]));
  // Its shots slot, as the shots machine leaves it.
  const shots = (s, { state, runId = null, results = [], stories = 1, at = 'NOW()' }) => asTransition((cl) => cl.query(
    `UPDATE chat_sessions SET shots_state = $2, shots_run_id = $3, shots_updated_at = ${at},
            shots_detail = $4::jsonb WHERE id = $1`,
    [s.id, state, runId, JSON.stringify({
      headSha: s.head, intent: { stories: Array.from({ length: stories }, (_, i) => ({ claim: `Story ${i + 1}` })) },
      claims: [{ id: 'c1', claim: 'The host shows on each meeting', steps: ['Open a meeting'] }],
      shotResults: results,
    })]));
  const inst = async (s) => (await pool.query('SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(s.id)])).rows[0];

  // Fake work: each call recorded; `answer` per kind.
  const work = { calls: [], answer: new Map() };
  const fake = (kind) => ({
    maxAttempts: 2, backoffMs: () => 0, leaseMs: 600,
    async run({ input, key }) {
      work.calls.push({ kind, key, input });
      const a = work.answer.get(kind);
      return typeof a === 'function' ? await a(input, key) : (a ?? { ok: true });
    },
  });
  const services = Object.fromEntries(Object.values(WORK).map((k) => [k, fake(k)]));
  const pushes = [];
  const bc = botChange();
  // A machine standing for the senders (named as the proposal machine, which
  // sends Proposed): its one transition writes what theirs write for the bot.
  const sender = defineMachine({
    name: 'proposal', version: 1, events: { Tell: (p) => p }, create: ['Tell'],
    decode: (row) => ({ name: row.state, data: row.data }),
    authorize: { Tell: () => true },
    transitions: { '(none)': { Tell: { to: (_s, e) => ({ next: { name: 'done', data: {} }, writes: [toBotChange(e.payload.sessionId, e.payload.event, e.payload.payload || {})] }) } },
      done: { Tell: { to: (_s, e) => ({ next: { name: 'done', data: {} }, writes: [toBotChange(e.payload.sessionId, e.payload.event, e.payload.payload || {})] }) } } },
    writes: { botChange: writeBotChange },
  });
  const rt = createRuntime({ pool, machines: [bc, sender], pollMs: 50, publish: async (_q, p) => { pushes.push(...p); }, services });
  runtimes.push(rt);

  let rk = 0;
  const system = { kind: 'system' };
  const settle = async () => {
    for (let i = 0; i < 60; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  const tell = async (s, type, payload = {}) => {
    const id = await rt.append(bc, sessionKey(s.id), { type, payload: { sessionId: s.id, ...payload } }, { requestKey: `t-${++rk}`, source: system });
    await settle();
    return (await pool.query('SELECT result, reason FROM wf_events WHERE id = $1', [id])).rows[0];
  };
  // The request's instance (bot-request) answering the round it was asked
  // for, as its transition's message reaches the change machine.
  const answer = async (s, type, payload) => {
    const from = { machine: 'bot-request', key: `request:${app.id}:${s.issueNumber}`, eventId: 1 };
    const id = await rt.append(bc, sessionKey(s.id), { type, payload: { sessionId: s.id, ...payload } },
      { requestKey: `a-${++rk}`, source: { kind: 'message', from } });
    await settle();
    return (await pool.query('SELECT result, reason FROM wf_events WHERE id = $1', [id])).rows[0];
  };
  const calls = (kind) => work.calls.filter((c) => c.kind === kind);
  const reset = () => { work.calls.length = 0; work.answer.clear(); pushes.length = 0; };
  // Its deadline, made due, and the clock's Look applied.
  const fire = async (s) => {
    await asTransition((cl) => cl.query('UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(s.id)]));
    await rt.fireTimers();
    await settle();
  };

  await t.test('B-create: only a change of the bot\'s, up for a vote, is followed', async () => {
    reset();
    const theirs = await change({ owner: person.id, run: false });
    assert.equal((await tell(theirs, 'Proposed')).reason, 'not_a_bot_change');
    assert.equal(await inst(theirs), undefined, 'nothing is kept for it');
    const underway = await change({ status: 'active' });
    assert.equal((await tell(underway, 'Verdict', { head: underway.head, state: 'passing' })).reason, 'not_up_for_vote');
    const s = await change();
    // The promote, as the proposal machine's transition sends it.
    await rt.append(sender, `x:${s.id}`, { type: 'Tell', payload: { sessionId: s.id, event: 'Proposed' } }, { requestKey: `s-${++rk}`, source: system });
    await settle();
    assert.equal((await inst(s)).state, 'checking', 'no verdict yet');
    assert.ok(pushes.some((p) => p.kind === 'user' && p.routing.userId === asker.id && p.data.type === 'homeroom_bot_work_changed'),
      'the requester\'s tray reads again (was bot.proposalChanged)');
  });

  await t.test('B-sender: another machine\'s transition tells it by its own write, for the bot\'s sessions only', async () => {
    reset();
    const s = await change();
    const theirs = await change({ owner: person.id, run: false });
    await rt.append(sender, `x:${s.id}`, { type: 'Tell', payload: { sessionId: s.id, event: 'Proposed' } }, { requestKey: `s-${++rk}`, source: system });
    await rt.append(sender, `x:${theirs.id}`, { type: 'Tell', payload: { sessionId: theirs.id, event: 'Proposed' } }, { requestKey: `s-${++rk}`, source: system });
    await settle();
    assert.equal((await inst(s)).state, 'checking');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM wf_events WHERE machine = $1 AND key = $2`, [MACHINE, sessionKey(theirs.id)]);
    assert.equal(rows[0].n, 0, 'no message about somebody else\'s session');
  });

  await t.test('B-ready: a passing verdict with nothing declared is ready to try, said once per epoch (bugs 2, 7)', async () => {
    reset();
    const s = await change();
    await tell(s, 'Proposed');
    await verdict(s, 'passing');
    await tell(s, 'Verdict', { head: s.head, state: 'passing' });
    assert.equal((await inst(s)).state, 'ready');
    assert.deepEqual(calls(WORK.ready).map((c) => [c.key, c.input.epoch, c.input.broken]), [['ready:1', 1, []]]);
    // Told by the verdict and the settle and the clock at once: one card.
    await tell(s, 'ShotsSettled');
    await tell(s, 'Verdict', { head: s.head, state: 'passing' });
    assert.equal(calls(WORK.ready).length, 1, 'one decider: the card (and the approvers\' bells) asked for once');
    // A new epoch (its votes cleared) is a new card.
    await asTransition((cl) => cl.query('UPDATE chat_sessions SET approval_epoch = 2 WHERE id = $1', [s.id]));
    await tell(s, 'Verdict', { head: s.head, state: 'passing' });
    assert.deepEqual(calls(WORK.ready).map((c) => c.key), ['ready:1', 'ready:2']);
  });

  await t.test('B-unsent: a ready card not sent because a merge began keeps its epoch untold; back up for its vote, it is asked again (PR review)', async () => {
    reset();
    const s = await change();
    await tell(s, 'Proposed');
    await verdict(s, 'passing');
    // The merge begins before the card's work runs: tellReady sends nothing.
    work.answer.set(WORK.ready, async () => {
      await asTransition((cl) => cl.query(`UPDATE chat_sessions SET status = 'merging' WHERE id = $1`, [s.id]));
      return { messageId: null, stale: true, notUp: true };
    });
    await tell(s, 'Verdict', { head: s.head, state: 'passing' });
    let i = await inst(s);
    assert.equal(i.data.told, null, 'nobody was told: the epoch is not used up');
    assert.ok(i.deadline_at, 'its clock looks again while it is being merged');
    // GitHub refused the merge: back up for its vote, on the same epoch.
    work.answer.set(WORK.ready, { messageId: 9, stale: false, notUp: false });
    await asTransition((cl) => cl.query(`UPDATE chat_sessions SET status = 'promoted' WHERE id = $1`, [s.id]));
    await fire(s);
    i = await inst(s);
    assert.equal(i.state, 'ready');
    assert.equal(i.data.told, 1);
    const keys = calls(WORK.ready).map((c) => c.key);
    assert.equal(keys.length, 2, 'asked again');
    assert.equal(keys[0], 'ready:1');
    assert.match(keys[1], /^ready:1:v\d+$/, 'under a key of its own (the DM\'s own key is the epoch\'s)');
    assert.deepEqual(calls(WORK.ready).map((c) => c.input.epoch), [1, 1]);
  });

  await t.test('B-hold: its shots still to come hold it, by the transaction\'s clock, moved by their activity (bugs 5, 6)', async () => {
    reset();
    const s = await change();
    await tell(s, 'Proposed');
    await shots(s, { state: 'exploring', runId: crypto.randomBytes(16).toString('hex') });
    await verdict(s, 'passing');
    await tell(s, 'Verdict', { head: s.head, state: 'passing' });
    let i = await inst(s);
    assert.equal(i.state, 'waiting_on_shots');
    assert.ok(Math.abs(new Date(i.deadline_at).getTime() - (Date.now() + READY_HOLD_MS)) < 60000, 'held 45 minutes from now');
    assert.equal(calls(WORK.ready).length, 0);
    // The clock comes while the run still moves (its slot moved 10 minutes
    // ago): held on, from that move (the sweep's window ignored it, bug 5).
    await shots(s, { state: 'exploring', runId: crypto.randomBytes(16).toString('hex'), at: `NOW() - INTERVAL '10 minutes'` });
    await asTransition((cl) => cl.query(`UPDATE chat_sessions SET checks_checked_at = NOW() - INTERVAL '50 minutes' WHERE id = $1`, [s.id]));
    await fire(s);
    i = await inst(s);
    assert.equal(i.state, 'waiting_on_shots');
    assert.ok(Math.abs(new Date(i.deadline_at).getTime() - (Date.now() + READY_HOLD_MS - 10 * 60000)) < 60000);
    // No settle ever comes: held long enough, it is ready anyway, by the
    // machine's own timer (the leader's sweep and its window are gone).
    await shots(s, { state: 'exploring', runId: crypto.randomBytes(16).toString('hex'), at: `NOW() - INTERVAL '50 minutes'` });
    await fire(s);
    assert.equal((await inst(s)).state, 'ready');
    assert.equal(calls(WORK.ready).length, 1);
  });

  const broken = [{ id: 'c1', status: 'failed', reason: 'The host was missing' }];

  await t.test('B-fix: shots showing part of it failing send it back to the bot, once per head, then ready with what does not work (bugs 3, 4, Q3)', async () => {
    reset();
    const s = await change();
    await tell(s, 'Proposed');
    await verdict(s, 'passing');
    await shots(s, { state: 'verified', results: broken });
    work.answer.set(WORK.fix, { queued: true });
    await tell(s, 'ShotsSettled');
    let i = await inst(s);
    assert.equal(i.state, 'with_the_bot');
    assert.deepEqual(calls(WORK.fix).map((c) => c.input.head), [s.head]);
    assert.match(calls(WORK.fix)[0].key, new RegExp(`^fix:${s.head.slice(0, 12)}:v\\d+$`));
    assert.equal(calls(WORK.ready).length, 0, 'no card while the bot fixes it');
    // No clock of its own, and no read of the bot's queue: its request's
    // instance (bot-request) answers how the round it asked for ended.
    assert.equal(i.deadline_at, null, 'it waits for its request\'s answer');
    assert.equal(FIX_ROUNDS, 2);
    // The round was lost (its look ended without it, bug 3; a release took
    // it, bug 4): asked once more.
    assert.equal((await answer(s, 'FixRoundEnded', { head: s.head, outcome: 'lost' })).result, 'accepted');
    assert.equal((await inst(s)).state, 'with_the_bot');
    assert.equal(calls(WORK.fix).length, 2);
    assert.notEqual(calls(WORK.fix)[0].key, calls(WORK.fix)[1].key, 'each ask is its own item');
    assert.equal(calls(WORK.ready).length, 0);
    // An answer about a head the change has left decides nothing new.
    await answer(s, 'FixRoundEnded', { head: SHA('9'), outcome: 'lost' });
    assert.equal((await inst(s)).state, 'with_the_bot');
    assert.equal(calls(WORK.fix).length, 2);
    // Lost again: the requester is told it is ready, saying what does not
    // work, and the bot is not asked a third time.
    await answer(s, 'FixRoundEnded', { head: s.head, outcome: 'lost' });
    i = await inst(s);
    assert.equal(i.state, 'ready');
    assert.equal(i.data.fix.gaveUp, true);
    assert.equal(calls(WORK.fix).length, 2);
    assert.deepEqual(calls(WORK.ready).map((c) => c.input.broken), [['The host shows on each meeting']]);
  });

  // A person's Stop of the bot's round (design-bot-loop Q1): that head is
  // not asked again; the next verdict, shots or promote asks when needed.
  await t.test('B-stopped: a round a person stopped is not asked again for that head', async () => {
    reset();
    const s = await change();
    await tell(s, 'Proposed');
    await verdict(s, 'passing');
    await shots(s, { state: 'verified', results: broken });
    work.answer.set(WORK.fix, { queued: true });
    await tell(s, 'ShotsSettled');
    assert.equal(calls(WORK.fix).length, 1);
    await answer(s, 'FixRoundEnded', { head: s.head, outcome: 'stopped' });
    const i = await inst(s);
    assert.equal(calls(WORK.fix).length, 1, 'not asked again at once');
    assert.equal(i.data.fix.refused, 'stopped');
    assert.equal(i.data.fix.gaveUp, false);
  });

  await t.test('B-round: the bot\'s round on the head ends: ready, saying what does not work (bug 4)', async () => {
    reset();
    const s = await change();
    await tell(s, 'Proposed');
    await verdict(s, 'passing');
    await shots(s, { state: 'verified', results: broken });
    work.answer.set(WORK.fix, { queued: true });
    await tell(s, 'ShotsSettled');
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, checks_head_sha) VALUES ($1, $2, 'live', 'person', $3, $4)`,
      [app.id, s.issueNumber, s.id, s.head]);
    await answer(s, 'FixRoundEnded', { head: s.head, outcome: 'looked' });
    assert.equal((await inst(s)).state, 'ready');
    assert.equal(calls(WORK.ready).length, 1);
    assert.deepEqual(calls(WORK.ready)[0].input.broken, ['The host shows on each meeting']);
    assert.equal(calls(WORK.fix).length, 1, 'a round that looked is never asked again');
  });

  await t.test('B-round-refused: the request will not take the round it was asked (FixRefused): ready with what does not work, until the next verdict', async () => {
    reset();
    const s = await change();
    await tell(s, 'Proposed');
    await verdict(s, 'passing');
    await shots(s, { state: 'verified', results: broken });
    work.answer.set(WORK.fix, { queued: true });
    await tell(s, 'ShotsSettled');
    assert.equal((await inst(s)).state, 'with_the_bot');
    await answer(s, 'FixRefused', { head: s.head, why: 'off' });
    const i = await inst(s);
    assert.equal(i.state, 'ready');
    assert.equal(i.data.fix.refused, 'off');
    assert.equal(calls(WORK.fix).length, 1);
    assert.deepEqual(calls(WORK.ready).map((c) => c.input.broken), [['The host shows on each meeting']]);
  });

  await t.test('B-refused: the bot does not take the round (off, not on the app): ready with what does not work at once', async () => {
    reset();
    const s = await change();
    await tell(s, 'Proposed');
    await verdict(s, 'passing');
    await shots(s, { state: 'verified', results: broken });
    work.answer.set(WORK.fix, { queued: false, why: 'off' });
    await tell(s, 'ShotsSettled');
    const i = await inst(s);
    assert.equal(i.state, 'ready');
    assert.equal(i.data.fix.refused, 'off');
    assert.equal(calls(WORK.ready).length, 1);
  });

  await t.test('B-failing: failing checks go back to the bot; one it will not take is said by nobody else, and the next verdict asks again (review R1-1, R1-2)', async () => {
    reset();
    const s = await change();
    await tell(s, 'Proposed');
    await verdict(s, 'failing', [{ name: 'host shows', status: 'fail', failureReason: 'expected host' }]);
    work.answer.set(WORK.fix, { queued: false, why: 'infra' });
    await tell(s, 'Verdict', { head: s.head, state: 'failing' });
    assert.equal(calls(WORK.fix).length, 1);
    assert.equal((await inst(s)).state, 'checking');
    assert.equal(calls(WORK.ready).length, 0, 'a failing change is never "ready to try", and nothing else is said here (the bot said it needs a look itself)');
    // The platform re-ran them on the same head and three real failures came back.
    work.answer.set(WORK.fix, { queued: true });
    await verdict(s, 'failing', [{ name: 'host shows', status: 'fail', failureReason: 'expected host' }]);
    await tell(s, 'Verdict', { head: s.head, state: 'failing' });
    assert.equal(calls(WORK.fix).length, 2, 'asked again: the bot decides afresh');
    assert.equal((await inst(s)).state, 'with_the_bot');
    // Its checks pass on the same epoch once fixed: ready now.
    await verdict(s, 'passing');
    await tell(s, 'Verdict', { head: s.head, state: 'passing' });
    assert.deepEqual(calls(WORK.ready).map((c) => c.key), ['ready:1']);
  });

  await t.test('B-build: a preview build that failed with its own error is a fix the bot takes (#6536)', async () => {
    reset();
    const BUILD_ROW = {
      name: 'Preview build', path: null, status: 'fail', previewBuild: true,
      failureReason: 'The preview build failed: frontend/src/features/ai/index.tsx:104:1: ERROR: Unexpected "**"',
      buildExcerpt: 'vite v5.4.21 building for production...\n✗ Build failed in 1.2s\nerror during build:\n'
        + 'frontend/src/features/ai/index.tsx:104:1: ERROR: Unexpected "**"',
    };
    const followup = require('../src/services/homeroom-bot-followup');
    const s = await change();
    await tell(s, 'Proposed');
    await verdict(s, 'error', [BUILD_ROW]);
    work.answer.set(WORK.fix, { queued: true });
    await tell(s, 'PreviewStopped', { head: s.head });
    assert.equal(calls(WORK.fix).length, 1, 'the build error is a fix it takes');
    assert.equal((await inst(s)).state, 'with_the_bot');

    // The fix turn is shown the build's own error.
    const { rows: [r] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [s.id]);
    const due = followup.checksDue(r);
    assert.ok(due);
    assert.equal(due.failing[0].previewBuild, true);
    assert.match(due.failing[0].buildExcerpt, /index\.tsx:104:1/);
    const prompt = followup.checksFixPrompt({ seed: 'Build this request', failing: due.failing, total: due.total });
    assert.match(prompt, /The preview build failed, so no check could run/);
    assert.match(prompt, /index\.tsx:104:1: ERROR: Unexpected "\*\*"/);

    // A build failure with no error line is not a fix: it is told as today.
    const quiet = await change();
    await tell(quiet, 'Proposed');
    await verdict(quiet, 'error', []);
    await tell(quiet, 'PreviewStopped', { head: quiet.head });
    assert.equal(calls(WORK.fix).length, 1, 'nothing was asked of the bot');
    assert.equal(calls(WORK.stopped).length, 1, 'it is told its preview will not start');
  });

  await t.test('B-off: a bot that is off takes no round, and nobody hears anything (as on [main])', async () => {
    reset();
    const s = await change();
    await tell(s, 'Proposed');
    await verdict(s, 'failing', [{ name: 'x', status: 'fail' }]);
    work.answer.set(WORK.fix, { queued: false, why: 'off' });
    await tell(s, 'Verdict', { head: s.head, state: 'failing' });
    assert.equal((await inst(s)).state, 'checking');
    assert.deepEqual(work.calls.map((c) => c.kind), [WORK.fix]);
  });

  await t.test('B-late: a fix result about a head the change has left settles nothing (review R1-3)', async () => {
    reset();
    const s = await change();
    await tell(s, 'Proposed');
    await verdict(s, 'failing', [{ name: 'x', status: 'fail' }]);
    let release;
    const gate = new Promise((r) => { release = r; });
    work.answer.set(WORK.fix, async (input) => { if (input.head === s.head) await gate; return input.head === s.head ? { queued: false, why: 'not_due' } : { queued: true }; });
    await rt.append(bc, sessionKey(s.id), { type: 'Verdict', payload: { sessionId: s.id, head: s.head, state: 'failing' } }, { requestKey: `t-${++rk}`, source: system });
    await rt.drain();
    const pending = rt.runServices();
    // The head moves to B with its own failing verdict while A's answer is late.
    const B = SHA('b');
    await asTransition((cl) => cl.query('UPDATE chat_sessions SET reviewed_head_sha = $2, checks_commit_sha = $2 WHERE id = $1', [s.id, B]));
    await tell({ ...s, head: B }, 'Verdict', { head: B, state: 'failing' });
    release();
    await pending;
    await settle();
    const i = await inst(s);
    assert.equal(i.data.fix.head, B);
    assert.equal(i.data.fix.refused, null, 'A\'s answer does not touch B\'s round');
    assert.equal(i.state, 'with_the_bot');
  });

  await t.test('B-merging, B-merged: being merged keeps the clock; a look that saw the merge first still lets its Merged stop the bot\'s work, bounded (review R1-4, R1-5)', async () => {
    reset();
    const s = await change();
    await tell(s, 'Proposed');
    await verdict(s, 'passing');
    await shots(s, { state: 'verified', results: broken });
    work.answer.set(WORK.fix, { queued: true });
    await tell(s, 'ShotsSettled');
    assert.equal((await inst(s)).state, 'with_the_bot');
    assert.equal((await inst(s)).deadline_at, null, 'with the bot: no clock until something tells it to look');
    await asTransition((cl) => cl.query(`UPDATE chat_sessions SET status = 'merging' WHERE id = $1`, [s.id]));
    // A look while it is being merged (another verdict) arms its clock.
    await tell(s, 'Verdict', { head: s.head, state: 'passing' });
    assert.ok((await inst(s)).deadline_at, 'its clock looks again while it is being merged');
    await fire(s);
    assert.ok((await inst(s)).deadline_at, 'its clock is kept while it is being merged');
    await asTransition((cl) => cl.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [s.id]));
    await fire(s);
    assert.equal((await inst(s)).state, 'merged');
    assert.equal(calls(WORK.merged).length, 0);
    await tell(s, 'Merged', { before: null });
    assert.equal(calls(WORK.merged).length, 1, 'the Merged after the look still stops the bot\'s other work');
    assert.ok(calls(WORK.merged)[0].input.before, 'bounded by the row\'s own merge time');
  });

  await t.test('B-reopen, B-stopped-held: a closed change reopened is followed again; a preview that will not start keeps the clock (review R1-6, R1-8)', async () => {
    reset();
    const s = await change();
    await tell(s, 'Proposed');
    await tell(s, 'Closed', { reason: 'stale-pr' });
    assert.equal((await inst(s)).state, 'closed');
    await verdict(s, 'passing');
    await tell(s, 'Proposed');
    assert.equal((await inst(s)).state, 'ready', 'put up for a vote again: followed again');
    assert.equal(calls(WORK.ready).length, 1);
    const h = await change();
    await tell(h, 'Proposed');
    await shots(h, { state: 'exploring', runId: crypto.randomBytes(16).toString('hex') });
    await verdict(h, 'passing');
    await tell(h, 'Verdict', { head: h.head, state: 'passing' });
    assert.equal((await inst(h)).state, 'waiting_on_shots');
    await tell(h, 'PreviewStopped', { head: h.head });
    const i = await inst(h);
    assert.equal(i.state, 'waiting_on_shots');
    assert.ok(i.deadline_at, 'the hold\'s clock is kept');
    assert.equal(calls(WORK.stopped).length, 1);
  });

  await t.test('B-stopped, B-live, B-closed: the preview that will not start, the merge and its live, the close', async () => {
    reset();
    const s = await change();
    await tell(s, 'Proposed');
    await tell(s, 'PreviewStopped', { head: s.head });
    await tell(s, 'PreviewStopped', { head: s.head });
    assert.deepEqual(calls(WORK.stopped).map((c) => c.key), ['stopped:1'], 'once per epoch');
    await asTransition((cl) => cl.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [s.id]));
    await tell(s, 'Merged', { before: new Date().toISOString() });
    assert.equal((await inst(s)).state, 'merged');
    assert.equal(calls(WORK.merged).length, 1, 'the bot\'s other work on the request stops');
    await tell(s, 'Live');
    await tell(s, 'Live');
    assert.equal((await inst(s)).state, 'live');
    assert.deepEqual([calls(WORK.liveDm).length, calls(WORK.livePost).length, calls(WORK.merged).length], [1, 1, 1]);
    // A change merged and live with no Merged first (an included one).
    const t2 = await change({ status: 'merged' });
    await tell(t2, 'Live');
    assert.deepEqual(calls(WORK.merged).map((c) => c.input.sessionId), [s.id, t2.id]);
    // Closed: the tray reads again, and nothing more is said.
    const c = await change();
    await tell(c, 'Proposed');
    await tell(c, 'Closed', { reason: 'closed' });
    assert.equal((await inst(c)).state, 'closed');
    assert.equal((await tell(c, 'Verdict', { head: c.head, state: 'passing' })).reason, 'ended');
    // The close's own write re-reads the requester's tray, for a change never followed too.
    const never = await change({ status: 'archived' });
    pushes.length = 0;
    await rt.append(sender, `x:${never.id}`, { type: 'Tell', payload: { sessionId: never.id, event: 'Closed', payload: { reason: 'closed' } } },
      { requestKey: `s-${++rk}`, source: system });
    await settle();
    assert.ok(pushes.some((p) => p.kind === 'user' && p.routing.userId === asker.id && p.data.type === 'homeroom_bot_work_changed'));
  });

  await t.test('B-retry: a note that failed for good is asked again by an admin, from its checkpoint', async () => {
    reset();
    const s = await change();
    await tell(s, 'Proposed');
    await verdict(s, 'passing');
    work.answer.set(WORK.ready, () => { throw new Error('the DM server is down'); });
    await tell(s, 'Verdict', { head: s.head, state: 'passing' });
    let i = await inst(s);
    assert.equal(i.data.notes['ready:1'].status, 'exhausted');
    work.answer.set(WORK.ready, { messageId: 7 });
    const id = await rt.append(bc, sessionKey(s.id), { type: 'RetryFollowup', payload: { workKey: 'ready:1' } },
      { requestKey: `r-${++rk}`, source: { kind: 'admin' } });
    await settle();
    assert.equal((await pool.query('SELECT result FROM wf_events WHERE id = $1', [id])).rows[0].result, 'accepted');
    i = await inst(s);
    assert.equal(i.data.notes['ready:1'].status, 'retried');
    // The ready card, and the two follow-up moments it decided (#6264).
    assert.equal(Object.values(i.data.notes).filter((n) => n.status === 'done').length, 3);
  });

  // A vote is told to the change's machine in the vote's own statement
  // (routes/votes.js recordVote, retractVote): it was a call after the
  // commit, which a restart lost.
  await t.test('B-vote: a vote on the bot\'s change reads its tray again, and a yes is no line in its request\'s thread', async () => {
    reset();
    const { recordVote, retractVote } = require('../src/routes/votes.js');
    const s = await change();
    await tell(s, 'Proposed');
    const { rows: [voter] } = await pool.query(`INSERT INTO users (username, password) VALUES ('vote_ada', 'x') RETURNING id, username`);
    const cast = (v) => recordVote({ pool, session: { id: s.id }, userId: voter.id, vote: v, headSha: s.head, revisionEnforced: false, voter: voter.username });
    reset();
    const yes = await cast('yes');
    assert.equal(yes.rowCount, 1, 'the vote is recorded as before');
    await settle();
    // 5 Nov 2026 (decision 6): its votes are on the change's page.
    assert.deepEqual(calls(WORK.approved), []);
    assert.deepEqual(pushes.filter((p) => p.data?.type === 'homeroom_bot_work_changed').map((p) => p.routing.userId), [asker.id]);
    await cast('no');
    await cast('yes');
    await settle();
    assert.equal(calls(WORK.approved).length, 0);
    pushes.length = 0;
    const out = await retractVote({ pool, sessionId: s.id, userId: voter.id });
    assert.equal(out.vote, 'yes');
    await settle();
    assert.equal(calls(WORK.approved).length, 0, 'taken back: still none');
    assert.equal(pushes.filter((p) => p.data?.type === 'homeroom_bot_work_changed').length, 1, 'its tray reads again');
    // A change the machine does not follow tells nobody.
    const other = await change({ owner: asker.id, run: false });
    await recordVote({ pool, session: { id: other.id }, userId: voter.id, vote: 'yes', headSha: other.head, revisionEnforced: false, voter: voter.username });
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM wf_events WHERE type = 'Voted' AND key = $1`, [sessionKey(other.id)])).rows[0].n, 0);
  });

  // #6264: the promises people asked for are kept by the change's own
  // moments, each asked once under its own key.
  await t.test('B-followups: each moment asks bot.tellFollowups once', async () => {
    reset();
    const s = await change();
    await tell(s, 'Proposed');
    await verdict(s, 'passing');
    await tell(s, 'Verdict', { head: s.head, state: 'passing' });
    assert.ok(calls(WORK.followups).some((c) => c.input.event === 'checks' && c.input.head === s.head),
      'the checks finishing is told');
    assert.ok(calls(WORK.followups).some((c) => c.key === 'followups:vote:1' && c.input.event === 'vote'),
      'ready to vote is told once at this epoch');
    await tell(s, 'Look');
    assert.equal(calls(WORK.followups).filter((c) => c.key === 'followups:vote:1').length, 1, 'asked once');
    await tell(s, 'Merged');
    assert.ok(calls(WORK.followups).some((c) => c.key === 'followups:merged'), 'merged is told');
    await tell(s, 'Live');
    assert.ok(calls(WORK.followups).some((c) => c.key === 'followups:live'), 'live is told');

    reset();
    const closed = await change();
    await tell(closed, 'Proposed');
    const out = await tell(closed, 'Closed', { reason: 'withdrawn' });
    assert.ok(['ok', 'accepted'].includes(out.result), 'the close is applied');
    assert.deepEqual(calls(WORK.followups).map((c) => [c.key, c.input.event]), [['followups:closed', 'closed']],
      'a close asks once, to call off what is still waiting');
  });

  await t.test('kernel: no notifier, and nothing a transition returns runs after COMMIT', async () => {
    assert.throws(() => defineMachine({ name: 'old-style', version: 1, events: {}, decode: (r) => r, authorize: {}, transitions: {}, notifiers: {} }),
      /notifiers are gone/);
    const kicking = defineMachine({
      name: 'kicking', version: 1, events: { Go: (p) => p }, create: ['Go'],
      decode: (row) => ({ name: row.state, data: row.data }), authorize: { Go: () => true },
      transitions: { '(none)': { Go: { to: () => ({ next: { name: 'gone', data: {} }, notify: [{ type: 'kick' }] }) } }, gone: { Go: { ignore: 'gone' } } },
    });
    const kr = createRuntime({ pool, machines: [kicking], pollMs: 50, publish: async () => {}, services: {} });
    runtimes.push(kr);
    const id = await kr.append(kicking, 'k:1', { type: 'Go', payload: {} }, { requestKey: 'k-1', source: system });
    await kr.drain();
    const { rows: [e] } = await pool.query('SELECT result, error FROM wf_events WHERE id = $1', [id]);
    assert.equal(e.result, 'faulted');
    assert.match(JSON.stringify(e.error), /returned notify/);
  });
});
