'use strict';
require('./lib/media-store').useMemoryMedia(require('node:test'));
const { fixtureKey } = require('./lib/media-store');

// The preview machine (src/workflow/preview/) against the full PostgreSQL
// schema: admission, supersession, publication, settlement, the error lane,
// deferral, retirement, adopting a session from its row, preview-only
// requests, a release's retry of the platform's faults, and who is working on a session
// (workflow-foundation's design-previews-and-checks.md). Work kinds are
// faked here, each recording what it was asked; services.ts has its own
// tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { preview, sessionKey, MACHINE, WORK, attemptDb } = require('../src/workflow/preview/machine.ts');
const { PROCESS_PRESENCE_LOCK } = require('../src/workflow/rules/presence.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);

test('preview machine against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_preview_' + crypto.randomBytes(6).toString('hex');
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
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:${MACHINE}', '1') ON CONFLICT DO NOTHING`);

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  async function user() {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [`pv_${++seq}`]);
    return u;
  }
  async function app() {
    const owner = await user();
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, repo_url)
       VALUES ($1::text, $1::text, $2, 'https://github.com/acme/' || $1::text) RETURNING *`,
      [`pv-app-${++seq}`, owner.id]);
    return a;
  }
  // The Homeroom bot: a change of its is followed by its change machine,
  // which the verdict's own write tells (rules/bot-notes.ts).
  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`);
  const toldBot = async (s) => (await pool.query(
    `SELECT type, payload FROM wf_events WHERE machine = 'bot-change' AND key = $1 ORDER BY id`, [`session:${s.id}`])).rows
    .map((e) => [e.type, e.payload.state ?? null]);
  async function proposal(a, { status = 'promoted', source = null, pin = null, extra = {}, bot = false } = {}) {
    const by = bot ? botUser : await user();
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, source, branch_name, pr_number, reviewed_head_sha, imported_pr_head_sha)
       VALUES ($1, $2, $3, $4, 'feature', $5, $6, $7) RETURNING *`,
      [a.id, by.id, status, source, ++seq, source === 'imported' ? null : pin, source === 'imported' ? pin : null]);
    if (Object.keys(extra).length) {
      const cols = Object.keys(extra);
      await pool.query(`UPDATE chat_sessions SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [s.id, ...cols.map((c) => extra[c])]);
    }
    return { ...s, app: a };
  }
  const row = async (id) => (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [id])).rows[0];
  const instance = async (s) => (await pool.query(
    'SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(s.id)])).rows[0];
  const workOf = async (s, kind) => (await pool.query(
    `SELECT kind, work_key, input, status, result, due_at FROM wf_work WHERE machine = $1 AND key = $2 AND ($3::text IS NULL OR kind = $3)
      ORDER BY created_at, work_key`, [MACHINE, sessionKey(s.id), kind || null])).rows;

  // What browsers heard: the pushes each transition published.
  const pushed = [];
  const heard = (s, event) => pushed.filter((p) => p.kind === 'session' && p.routing.sessionId === s.id
    && p.data.event === event);
  // Fake work: records each call; `answer` decides per kind (a function of
  // the input, or a value), `hold` keeps a kind running until released.
  const work = { calls: [], answer: new Map(), holds: new Map() };
  const fake = (kind) => ({
    maxAttempts: 2, backoffMs: () => 0, leaseMs: 600,
    async run({ input, key, signal }) {
      work.calls.push({ kind, key, input });
      const hold = work.holds.get(kind);
      if (hold) {
        await Promise.race([hold.promise, new Promise((r) => signal.addEventListener('abort', r, { once: true }))]);
      }
      const a = work.answer.get(kind);
      return typeof a === 'function' ? a(input) : (a ?? { ok: true });
    },
  });
  const hold = (kind) => {
    let release;
    const promise = new Promise((r) => { release = r; });
    work.holds.set(kind, { promise });
    return () => { work.holds.delete(kind); release(); };
  };
  const prepareOk = (input) => ({
    ok: true, url: `https://pv--s${input.sessionId}.apps.test`, runtimeKind: 'kubernetes',
    runtimeName: `sv-preview-1-s${input.sessionId}`, containerId: null, imageRef: `img@sha256:${input.n}`, buildRef: `b-${input.n}`,
  });
  // These apps have no repo unit suite, and their runs say so as a real run
  // does (visuals.settleCaptureRun's `unitSuiteAbsent`), which is what
  // answers a person's "Run checks again" (rules/check-store.ts unitAnswer).
  const verdict = (state, extra = {}) => () => ({
    outcome: 'verdict', state, unitSuiteAbsent: true,
    results: [{ index: 0, name: 'Loads /', status: state === 'passing' ? 'pass' : 'fail' }],
    console: { state: 'clean', errors: [] }, history: [{ checkKey: 'k1', name: 'Loads /', path: '/', passes: 1, fails: 0 }],
    capture: { state: 'console_only', detail: { media: false } }, visuals: false, ...extra,
  });
  work.answer.set(WORK.prepare, prepareOk);
  work.answer.set(WORK.run, verdict('passing'));
  work.answer.set(WORK.retire, { closed: true });

  const machine = preview({ maxRetries: 6, retireAfterMs: 0 });
  const rt = createRuntime({
    pool, machines: [machine], pollMs: 50, publish: async (q, list) => { pushed.push(...list); },
    services: Object.fromEntries(Object.values(WORK).map((k) => [k, fake(k)])),
  });
  runtimes.push(rt);

  let rk = 0;
  const send = (s, type, payload = {}, source = { kind: 'system' }) => rt.append(machine, sessionKey(s.id), { type, payload },
    { requestKey: `t-${++rk}`, source, appId: s.app_id });
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  const outcome = async (id) => (await pool.query('SELECT result, reason, state_after, emitted FROM wf_events WHERE id = $1', [id])).rows[0];
  // Bring an instance's deadline forward, as the pipeline would write it.
  const due = async (s) => {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await c.query(`UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2`, [MACHINE, sessionKey(s.id)]);
      await c.query('COMMIT');
    } finally { c.release(); }
  };
  const reply = async (id) => (await pool.query('SELECT reply FROM wf_events WHERE id = $1', [id])).rows[0].reply;
  const submit = (s, head, extra = {}) => send(s, 'RevisionSubmitted', { sessionId: s.id, head, source: 'test', trigger: 'commit-push', ...extra });

  await t.test('P1 a revision is built, published, checked and settled, with its history counted once', async () => {
    const s = await proposal(await app(), { pin: SHA('a'), bot: true });
    const id = await submit(s, SHA('a'));
    await rt.drain();
    assert.equal((await outcome(id)).state_after, 'preparing');
    let r = await row(s.id);
    assert.deepEqual([r.check_state, r.check_phase, r.checks_commit_sha, r.check_trigger], ['pending', 'building', SHA('a'), 'commit-push']);
    await settle();
    const i = await instance(s);
    assert.equal(i.state, 'settled');
    r = await row(s.id);
    assert.equal(r.staging_url, `https://pv--s${s.id}.apps.test`);
    assert.equal(r.staging_commit_sha, SHA('a'));
    assert.equal(r.check_state, 'passing');
    assert.equal(r.console_check_state, 'clean');
    assert.equal(r.capture_state, 'console_only');
    const prepare = (await workOf(s, WORK.prepare))[0];
    assert.equal(prepare.input.db, attemptDb(s.app.slug, s.id, i.data.seed, 1));
    const { rows: history } = await pool.query('SELECT pass_count FROM app_check_history WHERE app_id = $1', [s.app_id]);
    assert.deepEqual(history.map((h) => h.pass_count), [1]);
    assert.deepEqual(await toldBot(s), [['Verdict', 'passing']],
      'a passing verdict tells the bot\'s change machine once, by message (no follow-up work)');
    assert.deepEqual(heard(s, 'staging_ready').map((p) => p.data.url), [`https://pv--s${s.id}.apps.test`]);
    assert.deepEqual(heard(s, 'checks_ready').map((p) => p.data.checkState), ['pending', 'pending', 'passing'],
      'building, testing, then the verdict, as the badges hear them');
    assert.ok(heard(s, 'checks_ready').every((p) => p.routing.fanout === true && p.routing.userId === s.user_id));
    const publish = (await workOf(s, WORK.publish))[0];
    assert.equal(publish.input.state, 'passing', 'the platform-variables check refreshes on a verdict (review finding 4)');
    const kinds = (await workOf(s)).map((w) => w.kind).sort();
    assert.deepEqual(kinds, [WORK.run, WORK.publish, WORK.prepare, WORK.unitEarly].sort());
    // The shots machine hears the head: when the preview served, and when
    // the verdict settled (messages, not hand-off work).
    const { rows: told } = await pool.query(
      `SELECT type, payload FROM wf_events WHERE machine = 'shots' AND key = $1 ORDER BY id`, [sessionKey(s.id)]);
    assert.deepEqual(told.map((e) => [e.type, e.payload.head]), [['HeadReady', SHA('a')], ['HeadReady', SHA('a')]]);
  });

  await t.test('P2 the same head joins; a stale producer is refused; a newer head cancels the attempt and retires it', async () => {
    const s = await proposal(await app(), { status: 'active' });
    const release = hold(WORK.prepare);
    await submit(s, SHA('a'));
    await rt.drain();
    const running = rt.runServices();
    await new Promise((r) => setTimeout(r, 50));
    const again = await submit(s, SHA('a'));
    await rt.drain();
    assert.equal((await outcome(again)).reason, 'same_head');
    const newer = await submit(s, SHA('b'));
    await rt.drain();
    assert.equal((await outcome(newer)).state_after, 'preparing');
    await running;   // the held handler saw its signal abort
    release();
    const prepares = await workOf(s, WORK.prepare);
    assert.deepEqual(prepares.map((w) => [w.work_key, w.status, w.result]),
      [['prepare:1', 'settled', { cancelled: true }], ['prepare:2', 'queued', null]]);
    assert.deepEqual((await workOf(s, WORK.retireAttempt)).map((w) => [w.work_key.replace(/:v\d+$/, ''), w.input.n]), [['retire-attempt:1', 1]]);
    await settle();
    assert.equal((await instance(s)).state, 'settled');
    assert.equal((await row(s.id)).staging_commit_sha, SHA('b'));
    assert.deepEqual((await instance(s)).data.retiring, []);

    const promoted = await proposal(await app(), { pin: SHA('c') });
    const stale = await submit(promoted, SHA('d'));
    await rt.drain();
    assert.equal((await outcome(stale)).reason, 'head_superseded');
    assert.equal(await instance(promoted), undefined, 'a refused first event leaves no instance');
  });

  await t.test('P3 a newer head during checks cancels the run by its id, and its late result is refused', async () => {
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('a'));
    await rt.drain();
    await rt.runServices();   // prepare
    await rt.drain();
    assert.equal((await instance(s)).state, 'checking');
    const release = hold(WORK.run);
    const running = rt.runServices();
    await new Promise((r) => setTimeout(r, 50));
    await submit(s, SHA('b'));
    await rt.drain();
    release();
    await running;
    const cancels = await workOf(s, WORK.cancel);
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0].input.runId, (await workOf(s, WORK.run))[0].work_key);
    await settle();
    const i = await instance(s);
    assert.equal(i.state, 'settled');
    assert.equal(i.data.head, SHA('b'));
    const { rows: refused } = await pool.query(
      `SELECT reason FROM wf_events WHERE key = $1 AND type = 'WorkSucceeded' AND result = 'rejected'`, [sessionKey(s.id)]);
    assert.ok(refused.every((e) => e.reason === 'work_cancelled'));
  });

  await t.test('P4 a failed candidate leaves the serving preview linked; the error lane retries it', async () => {
    const s = await proposal(await app(), { pin: SHA('a') });
    await submit(s, SHA('a'));
    await settle();
    const served = await row(s.id);
    await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, SHA('b')]);
    work.answer.set(WORK.prepare, (input) => (input.head === SHA('b')
      ? { ok: false, detail: 'Container exited with code 1', infrastructure: false }
      : prepareOk(input)));
    await submit(s, SHA('b'));
    await settle();
    const i = await instance(s);
    assert.equal(i.state, 'failed');
    assert.equal(i.data.serving.head, SHA('a'), 'the older attempt still serves');
    const r = await row(s.id);
    assert.equal(r.staging_url, served.staging_url, 'and stays linked (bug 4)');
    assert.equal(r.staging_commit_sha, SHA('a'));
    assert.deepEqual([r.check_state, r.checks_commit_sha, r.consecutive_check_failures], ['error', SHA('b'), 1]);
    assert.ok(r.check_error_notified_at, 'the author was told once');
    const notes = `SELECT content FROM chat_session_messages WHERE session_id = $1 AND metadata ? 'checkError'`;
    const { rows: lines } = await pool.query(notes, [s.id]);
    assert.equal(lines.length, 1);
    assert.match(lines[0].content, /Container exited with code 1/);
    assert.ok(i.deadline_at, 'a promoted row is in the error lane');
    assert.deepEqual((await workOf(s, WORK.retireAttempt)).map((w) => w.input.n), [2], 'the failed attempt is retired');
    // RetryDue: a new attempt of the same head; a second failure stays quiet.
    await due(s);
    await rt.fireTimers();
    await settle();
    assert.equal((await instance(s)).data.streak, 2);
    assert.equal((await row(s.id)).consecutive_check_failures, 2);
    assert.equal((await pool.query(notes, [s.id])).rows.length, 1);
    work.answer.set(WORK.prepare, prepareOk);
    await send(s, 'RecheckRequested', { reason: 'manual' }, { kind: 'route' });
    await settle();
    assert.equal((await instance(s)).state, 'settled');
    assert.equal((await row(s.id)).staging_commit_sha, SHA('b'));
    assert.equal((await row(s.id)).consecutive_check_failures, 0);
  });

  await t.test('P5 a run that cannot say is an error, never a verdict, and adds no history', async () => {
    const s = await proposal(await app(), { status: 'active', bot: true });
    work.answer.set(WORK.run, { outcome: 'blocked', reason: 'The capture Job output could not be read' });
    await submit(s, SHA('e'));
    await settle();
    work.answer.set(WORK.run, verdict('passing'));
    const r = await row(s.id);
    assert.deepEqual([r.check_state, r.check_error_detail], ['error', 'The capture Job output could not be read']);
    assert.equal((await instance(s)).deadline_at, null, 'an active native row is outside the error lane');
    const { rows } = await pool.query('SELECT 1 FROM app_check_history WHERE app_id = $1', [s.app_id]);
    assert.equal(rows.length, 0);
    assert.deepEqual(await toldBot(s), [], 'an error is no verdict: the bot hears nothing, nor does the merge queue');
    assert.equal(r.check_error_platform, false, 'an unreadable run is the proposal\'s error');
    // A run whose Pods never started is the platform's fault, as [main] says
    // it (check-pod-start.js): the automatic retries a proposal's own errors
    // get are not spent on it.
    const t2 = await proposal(await app(), { status: 'active' });
    work.answer.set(WORK.run, { outcome: 'blocked', reason: 'The browser checks could not start', platformFault: true });
    await submit(t2, SHA('e'));
    await settle();
    work.answer.set(WORK.run, verdict('passing'));
    const r2 = await row(t2.id);
    assert.deepEqual([r2.check_state, r2.check_error_platform], ['error', true]);
    // So is a run that never answered: its handler kept failing.
    const t3 = await proposal(await app(), { status: 'active' });
    work.answer.set(WORK.run, () => { throw new Error('the database went away'); });
    await submit(t3, SHA('e'));
    await settle();
    work.answer.set(WORK.run, verdict('passing'));
    const r3 = await row(t3.id);
    assert.deepEqual([r3.check_state, r3.check_error_platform], ['error', true]);
  });

  await t.test('P6 a deferred head waits for ConflictResolved, once per episode', async () => {
    const s = await proposal(await app(), { pin: SHA('f') });
    work.answer.set(WORK.run, { outcome: 'deferred', capture: { state: 'console_only', detail: { deferred: true } } });
    await submit(s, SHA('f'));
    await settle();
    work.answer.set(WORK.run, verdict('failing'));
    assert.equal((await instance(s)).state, 'deferred');
    assert.deepEqual([(await row(s.id)).check_state, (await row(s.id)).check_phase], ['pending', 'deferred']);
    const wrong = await send(s, 'ConflictResolved', { head: SHA('9') });
    await rt.drain();
    assert.equal((await outcome(wrong)).reason, 'not_deferred_head');
    await send(s, 'ConflictResolved', { head: SHA('f') });
    await settle();
    assert.equal((await instance(s)).state, 'settled');
    assert.equal((await row(s.id)).check_state, 'failing');
  });

  // The measurement that finds a deferred head clean tells the machine in its
  // own statement (services/integration.js measure): no hook after the
  // commit, which a restart in between lost while the row already said clean.
  await t.test('P6b a measurement flipping the deferred head to clean resumes its checks; another head does not', async () => {
    const mirror = require('../src/services/repo-mirror');
    const integration = require('../src/services/integration');
    let measuredHead = SHA('9');
    const fns = {
      ensureMirror: async () => '/tmp/not-a-real-mirror', defaultBranchSha: async () => SHA('b'),
      resolveBranch: async () => measuredHead, mergeBase: async () => SHA('c'), behindBy: async () => 1, aheadBy: async () => 1,
      mergeTree: async () => ({ clean: true, conflicts: [], tree: SHA('e') }), hasCommit: async () => true, isAncestor: async () => true,
    };
    const real = new Map(Object.keys(fns).map((k) => [k, mirror[k]]));
    Object.assign(mirror, fns);
    try {
      const s = await proposal(await app(), { pin: SHA('d') });
      work.answer.set(WORK.run, { outcome: 'deferred', capture: { state: 'console_only', detail: { deferred: true } } });
      await submit(s, SHA('d'));
      await settle();
      work.answer.set(WORK.run, verdict('passing'));
      assert.equal((await instance(s)).state, 'deferred');
      const measure = async (head, wasHead) => {
        measuredHead = head;
        await pool.query(`UPDATE chat_sessions SET integration_merges_clean = FALSE, integration_head_sha = $2 WHERE id = $1`, [s.id, wasHead]);
        await integration.measure({ pool, session: { ...(await row(s.id)), repo_url: s.app.repo_url } }, { force: true });
        await settle();
      };
      await measure(SHA('9'), SHA('9'));
      assert.equal((await instance(s)).state, 'deferred', 'another head flipping clean is not the deferred one');
      await measure(SHA('d'), SHA('8'));
      assert.equal((await instance(s)).state, 'deferred', 'a new head measuring clean is not a flip');
      await measure(SHA('d'), SHA('d'));
      assert.equal((await instance(s)).state, 'settled');
      assert.equal((await row(s.id)).check_state, 'passing');
      const told = (await pool.query(`SELECT payload, request_key FROM wf_events WHERE machine = $1 AND key = $2 AND type = 'ConflictResolved'`,
        [MACHINE, sessionKey(s.id)])).rows;
      assert.deepEqual(told.map((e) => e.payload.head), [SHA('9'), SHA('d')]);
    } finally {
      for (const [k, v] of real) mirror[k] = v;
    }
  });

  await t.test('P7 retirement: an exit is terminal and clears the row; an idle one keeps the newest revision', async () => {
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('1'));
    await settle();
    const idle = await send(s, 'RetireRequested', { reason: 'idle', terminal: false });
    await rt.drain();
    assert.equal((await outcome(idle)).state_after, 'retiring');
    assert.equal((await row(s.id)).staging_url, null);
    const during = await submit(s, SHA('2'));
    await rt.drain();
    assert.equal((await outcome(during)).state_after, 'retiring');
    await settle();
    let i = await instance(s);
    assert.equal(i.state, 'settled', 'the revision that arrived during the retirement was built after it');
    assert.equal(i.data.serving.head, SHA('2'));
    const retire = (await workOf(s, WORK.retire))[0];
    assert.deepEqual(retire.input.attempts.map((a) => a.n), [1]);

    await pool.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = $1`, [s.id]);
    await send(s, 'RetireRequested', { reason: 'archived', terminal: true });
    await settle();
    i = await instance(s);
    assert.equal(i.state, 'retired');
    assert.ok(i.data.closedAt);
    const archived = await submit(s, SHA('3'));
    await rt.drain();
    assert.equal((await outcome(archived)).reason, 'not_open');
    // Unarchived: it starts again from its row, numbering on.
    await pool.query(`UPDATE chat_sessions SET status = 'active' WHERE id = $1`, [s.id]);
    const again = await submit(s, SHA('3'));
    await rt.drain();
    assert.equal((await outcome(again)).state_after, 'preparing');
    assert.equal((await instance(s)).data.preparing.n, 3);
    await settle();
  });

  await t.test('P8 a retire or a clear adopts a session the machine does not hold, from its row', async () => {
    // A preview built before the machine (attempt 0, [main]'s names) on a
    // row nobody has enrolled: an exit retires it by its old name.
    const s = await proposal(await app(), { status: 'archived', extra: {
      staging_url: 'https://legacy', staging_runtime_name: 'sv-preview-legacy', staging_runtime_kind: 'kubernetes',
      staging_commit_sha: SHA('5'), checks_commit_sha: SHA('5'), check_state: 'passing' } });
    assert.equal(await instance(s), undefined);
    const exit = await send(s, 'RetireRequested', { reason: 'archived', terminal: true, sessionId: s.id });
    await settle();
    assert.equal((await outcome(exit)).result, 'accepted');
    assert.equal((await instance(s)).state, 'retired');
    assert.deepEqual((await workOf(s, WORK.retire))[0].input.attempts.map((a) => [a.n, a.db]),
      [[0, `app_${s.app.slug.replace(/-/g, '_')}_staging_s${s.id}_555555`]], 'retired by its [main] name');
    assert.equal((await row(s.id)).staging_url, null);
    // An idle retire of a row under review is refused, as for one held.
    const promoted = await proposal(await app(), { status: 'promoted' });
    const refused = await send(promoted, 'RetireRequested', { reason: 'idle', terminal: false, sessionId: promoted.id });
    await rt.drain();
    assert.equal((await outcome(refused)).reason, 'under_review');
    // Nothing serves: the row's leftover pointers go, and nothing is built.
    const bare = await proposal(await app(), { status: 'active', extra: { staging_url: 'https://half' } });
    await send(bare, 'RetireRequested', { reason: 'idle', terminal: false, sessionId: bare.id });
    await settle();
    assert.equal((await instance(bare)).state, 'idle');
    assert.equal((await row(bare.id)).staging_url, null);
    assert.deepEqual(await workOf(bare, WORK.prepare), []);
    // A clear on a row the machine does not hold: the verdict goes, through it.
    const clr = await proposal(await app(), { status: 'paused', extra: { checks_commit_sha: SHA('6'), check_state: 'failing' } });
    await send(clr, 'ChecksCleared', { reason: 'paused-update', sessionId: clr.id }, { kind: 'route' });
    await rt.drain();
    assert.equal((await row(clr.id)).check_state, null);
    assert.ok(await instance(clr), 'adopted');
    // An event that names no session cannot adopt one.
    const anon = await proposal(await app(), { status: 'active' });
    const none = await send(anon, 'RetireRequested', { reason: 'idle', terminal: false });
    await rt.drain();
    assert.equal((await outcome(none)).reason, 'no_instance');
  });

  await t.test('P24 a preview-only request builds and serves, runs no checks, and writes no verdict', async () => {
    const s = await proposal(await app(), { status: 'paused', extra: { is_headless: true } });
    const ask = await send(s, 'PreviewRequested', { sessionId: s.id, head: SHA('7'), reason: 'preview' }, { kind: 'route' });
    await settle();
    assert.equal((await outcome(ask)).result, 'accepted');
    let i = await instance(s);
    assert.deepEqual([i.state, i.data.verdict, i.data.previewOnly, i.data.serving.head], ['settled', null, true, SHA('7')]);
    assert.deepEqual(await workOf(s, WORK.run), [], 'no checks run');
    let r = await row(s.id);
    assert.equal(r.staging_commit_sha, SHA('7'));
    assert.deepEqual([r.check_state, r.checks_commit_sha], [null, null], 'no checks state written');
    assert.equal(heard(s, 'staging_ready').length, 1);
    const recheck = await send(s, 'RecheckRequested', { reason: 'manual' }, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(recheck)).reason, 'preview_only');
    // A failed build: no verdict, no note to anyone, no retry of its own.
    work.answer.set(WORK.prepare, () => ({ ok: false, detail: 'Image build failed' }));
    const s2 = await proposal(await app(), { status: 'paused', extra: { is_headless: true } });
    await send(s2, 'PreviewRequested', { sessionId: s2.id, head: SHA('8'), reason: 'preview' }, { kind: 'route' });
    await settle();
    i = await instance(s2);
    assert.deepEqual([i.state, i.data.failure, i.deadline_at], ['failed', 'Image build failed', null]);
    r = await row(s2.id);
    assert.deepEqual([r.check_state, r.check_error_notified_at], [null, null]);
    assert.deepEqual(await toldBot(s2), []);
    assert.equal(heard(s2, 'staging_failed').length, 1);
    work.answer.set(WORK.prepare, prepareOk);
  });

  await t.test('P25 a release retries a platform fault at once; a proposal\'s own failure waits for its timer', async () => {
    const s = await proposal(await app(), { pin: SHA('9') });
    work.answer.set(WORK.prepare, () => ({ ok: false, detail: 'The preview database server refused', platformFault: true }));
    await submit(s, SHA('9'));
    await settle();
    assert.equal((await instance(s)).state, 'failed');
    work.answer.set(WORK.prepare, prepareOk);
    const now = await send(s, 'RetryDue', {}, { kind: 'system', name: 'release-retry' });
    await settle();
    assert.equal((await outcome(now)).result, 'accepted');
    assert.equal((await instance(s)).state, 'settled');
    const byRoute = await send(s, 'RetryDue', {}, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(byRoute)).reason, 'timer_only');
  });

  await t.test('P26 the unit suite starts with each build, goes with a superseded one, and not for a failing head', async () => {
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('1'));
    await rt.drain();
    let early = await workOf(s, WORK.unitEarly);
    assert.deepEqual(early.map((w) => [w.work_key, w.input.n, w.input.head]), [['unit-early:1', 1, SHA('1')]]);
    await submit(s, SHA('2'));   // before the first build ran
    await rt.drain();
    early = await workOf(s, WORK.unitEarly);
    assert.deepEqual(early.map((w) => w.work_key), ['unit-early:1', 'unit-early:2']);
    assert.deepEqual(early[0].result, { cancelled: true }, 'the superseded attempt\'s suite is cancelled');
    await settle();
    assert.equal((await instance(s)).state, 'settled');

    // A head whose build failed is built again with no early suite.
    work.answer.set(WORK.prepare, () => ({ ok: false, detail: 'Image build failed' }));
    const s2 = await proposal(await app(), { pin: SHA('3') });
    await submit(s2, SHA('3'));
    await settle();
    assert.equal((await instance(s2)).state, 'failed');
    work.answer.set(WORK.prepare, prepareOk);
    await due(s2);
    await rt.fireTimers();
    await settle();
    assert.equal((await instance(s2)).state, 'settled');
    assert.deepEqual((await workOf(s2, WORK.unitEarly)).map((w) => w.work_key), ['unit-early:1']);

    // A preview with no checks has no suite to start.
    const s3 = await proposal(await app(), { status: 'paused', extra: { is_headless: true } });
    await send(s3, 'PreviewRequested', { sessionId: s3.id, head: SHA('4'), reason: 'preview' }, { kind: 'route' });
    await settle();
    assert.deepEqual(await workOf(s3, WORK.unitEarly), []);
  });

  await t.test('P27 the lines people read: the dev chat\'s outcome rows and an imported proposal\'s thread notes', async () => {
    const card = (s) => pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', 'Building staging preview...', '{"stagingBuild":"running","changesReady":true}')`, [s.id]);
    const devChat = async (s) => (await pool.query(
      `SELECT content, metadata FROM chat_session_messages WHERE session_id = $1 AND role = 'system' ORDER BY id`, [s.id])).rows;

    // A native proposal: the preview that serves is a row, with its URL.
    const s = await proposal(await app(), { status: 'active' });
    await card(s);
    await submit(s, SHA('5'));
    await settle();
    let rows = await devChat(s);
    assert.deepEqual(rows.map((r) => r.content), ['Building staging preview...', 'Staging deployed!']);
    assert.equal(rows[1].metadata.stagingUrl, `https://pv--s${s.id}.apps.test`);

    // A failed build closes the open card once; the streak's note says why.
    work.answer.set(WORK.prepare, () => ({ ok: false, detail: 'Image build failed' }));
    const s2 = await proposal(await app(), { pin: SHA('6') });
    await card(s2);
    await submit(s2, SHA('6'));
    await settle();
    await due(s2);
    await rt.fireTimers();
    await settle();
    assert.equal((await instance(s2)).data.streak, 2, 'it was built twice');
    work.answer.set(WORK.prepare, prepareOk);
    rows = await devChat(s2);
    assert.deepEqual(rows.filter((r) => r.content === 'Staging build failed').map((r) => [r.metadata.stagingFailed, r.metadata.error]),
      [[true, 'Image build failed']], 'once: the retry finds no open card');
    assert.equal(rows.filter((r) => r.metadata.checkError).length, 1, 'the note to the author, once a streak');

    // An imported pull request has no dev chat: its thread hears both ends.
    const s3 = await proposal(await app(), { source: 'imported', pin: SHA('7'), extra: { pr_title: 'Fix the footer' } });
    pushed.length = 0;
    await submit(s3, SHA('7'));
    await settle();
    const { rows: notes } = await pool.query(
      `SELECT content, metadata FROM chat_messages WHERE thread_type = 'session' AND thread_ref = $1 ORDER BY id`, [s3.id]);
    assert.deepEqual(notes.map((n) => [n.metadata.stagingBuild, n.metadata.headSha]), [['started', SHA('7')], ['ready', SHA('7')]]);
    assert.match(notes[0].content, new RegExp(`PR #${s3.pr_number}: Fix the footer`));
    assert.equal(notes[1].metadata.stagingUrl, `https://pv--s${s3.id}.apps.test`);
    assert.equal(pushed.filter((p) => p.kind === 'room' && p.data.type === 'chat'
      && p.data.thread?.ref === s3.id).length, 2, 'both pushed to the app\'s room');
    assert.deepEqual(await devChat(s3), [], 'nothing in a dev chat it does not have');
  });

  await t.test('P10 a head with nothing beyond main settles skipped without a build, and kicks the queue', async () => {
    const s = await proposal(await app(), { status: 'promoted', pin: SHA('8'), bot: true });
    const id = await send(s, 'ChecksSkipped', { sessionId: s.id, head: SHA('9'), reason: 'branch has no commits beyond main' });
    await rt.drain();
    assert.equal((await outcome(id)).state_after, 'settled');
    const r = await row(s.id);
    assert.deepEqual([r.check_state, r.checks_commit_sha, r.check_error_detail], ['skipped', SHA('9'), 'branch has no commits beyond main']);
    assert.equal((await workOf(s, WORK.prepare)).length, 0);
    assert.deepEqual(await toldBot(s), [['Verdict', 'skipped']]);
  });

  await t.test('P11 a mechanical merge carries a green verdict to the merged head; anything else is checked', async () => {
    work.answer.set(WORK.run, verdict('passing'));
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('a'));
    await settle();
    const carried = await submit(s, SHA('b'), { carryFrom: SHA('a') });
    await rt.drain();
    assert.equal((await outcome(carried)).state_after, 'settled');
    assert.deepEqual([(await row(s.id)).checks_commit_sha, (await row(s.id)).check_state], [SHA('b'), 'passing']);
    assert.equal((await instance(s)).data.serving.head, SHA('a'), 'the tested head still serves');
    const stale = await submit(s, SHA('c'), { carryFrom: SHA('a') });
    await rt.drain();
    assert.equal((await outcome(stale)).state_after, 'preparing', 'a carry from a head that is not the settled one is checked');
    await settle();
  });

  await t.test('P13 code nothing checks yet clears the verdict through the machine and cancels the old run', async () => {
    work.answer.set(WORK.run, verdict('passing'));
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('a'));
    await rt.drain();
    await rt.runServices();   // prepare
    await rt.drain();
    assert.equal((await instance(s)).state, 'checking');
    const id = await send(s, 'ChecksCleared', { reason: 'upload' });
    await rt.drain();
    assert.equal((await outcome(id)).state_after, 'settled');
    const i = await instance(s);
    assert.equal(i.data.verdict, null);
    assert.deepEqual((await workOf(s, WORK.run)).map((w) => w.result), [{ cancelled: true }]);
    const r = await row(s.id);
    assert.deepEqual([r.check_state, r.check_phase, r.capture_state], [null, null, null]);
    assert.equal(r.staging_url, `https://pv--s${s.id}.apps.test`, 'the preview still serves');
    // Submitting the same head again checks it: a cleared verdict is not a join.
    const again = await submit(s, SHA('a'));
    await rt.drain();
    assert.equal((await outcome(again)).state_after, 'preparing');
    await settle();
  });

  await t.test('P9 manual requests: ensure joins what serves, deploy builds again, a recheck waits for the run', async () => {
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('7'));
    await settle();
    const ensure = await send(s, 'PreviewRequested', { sessionId: s.id, head: SHA('7'), reason: 'ensure' }, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(ensure)).reason, 'already_serving');
    await send(s, 'PreviewRequested', { sessionId: s.id, head: SHA('7'), reason: 'deploy' }, { kind: 'route' });
    await rt.drain();
    // A person's recheck joins the build going, recorded on its head as owed
    // a fresh unit suite (services/unit-suite-reuse.js); a system one is
    // refused as joined.
    const busy = await send(s, 'RecheckRequested', { reason: 'manual' }, { kind: 'route' });
    await rt.drain();
    assert.deepEqual([(await outcome(busy)).result, (await outcome(busy)).state_after], ['accepted', 'preparing']);
    assert.equal((await row(s.id)).unit_suite_fresh_sha, SHA('7'));
    const sweep = await send(s, 'RecheckRequested', { reason: 'stuck-checks-sweep' });
    await rt.drain();
    assert.equal((await outcome(sweep)).reason, 'run_outstanding');
    await settle();
    const i = await instance(s);
    assert.equal(i.data.serving.n, 2, 'deploy built a new attempt of the same head');
    const recheck = await send(s, 'RecheckRequested', { reason: 'manual' }, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(recheck)).result, 'accepted');
    assert.deepEqual(await reply(recheck), { state: 'checking', head: SHA('7'), url: `https://pv--s${s.id}.apps.test`, verdict: null });
  });
  await t.test('P14 a run\'s media is published with its verdict, and a stale run\'s never is', async () => {
    const s = await proposal(await app(), { status: 'active', bot: true });
    const media = async (runId, id) => {
      const data = Buffer.from([0]);
      const key = await fixtureKey(pool, data);
      const meta = require('../src/services/check-visual-media').metadata(data);
      return pool.query(
        `INSERT INTO check_run_media (id, run_id, session_id, commit_hash, kind, media, content_type, object_key, sha256, bytes, legacy_etag)
         VALUES ($1, $2, $3, $4, 'after', 'png', 'image/png', $5, $6, $7, $8)`,
        [id, runId, s.id, SHA('a'), key, meta.sha256, meta.bytes, meta.legacyEtag]);
    };
    work.answer.set(WORK.run, async (input) => {
      await media(input.runId, `m-${input.runId}`.slice(0, 32));
      return verdict('passing', { visuals: { captures: [{ index: 0 }] } })();
    });
    await submit(s, SHA('a'));
    await settle();
    const { rows: shown } = await pool.query('SELECT id, commit_hash FROM session_visuals WHERE session_id = $1', [s.id]);
    assert.equal(shown.length, 1, 'published to session_visuals in the settling transaction');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM check_run_media WHERE session_id = $1', [s.id])).rows[0].n, 0);
    assert.deepEqual(heard(s, 'visuals_ready').map((p) => p.data.visuals), [{ captures: [{ index: 0 }] }]);
    const publish = (await workOf(s, WORK.publish))[0];
    assert.equal(publish.input.visuals, true, 'the PR body is patched from what was published');

    // A run whose head the row has since left stores nothing, media included.
    work.answer.set(WORK.run, async (input) => {
      await media(input.runId, `n-${input.runId}`.slice(0, 32));
      // The row moved on meanwhile (as a writer the guard lets through).
      const c = await pool.connect();
      try {
        await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
        await c.query(`UPDATE chat_sessions SET checks_commit_sha = $2 WHERE id = $1`, [s.id, SHA('f')]);
        await c.query('COMMIT');
      } finally { c.release(); }
      return verdict('failing')();
    });
    await send(s, 'RecheckRequested', { reason: 'manual' }, { kind: 'route' });
    await settle();
    work.answer.set(WORK.run, verdict('passing'));
    const r = await row(s.id);
    assert.equal(r.check_state, 'pending', 'the stale verdict was not stored');
    assert.equal((await toldBot(s)).length, 1, 'and set nothing off (review finding)');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM session_visuals WHERE session_id = $1', [s.id])).rows[0].n, 1,
      'nor its media');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM check_run_media WHERE session_id = $1', [s.id])).rows[0].n, 0);
  });

  await t.test('P15 an admin ends a build or a run that never answers', async () => {
    const s = await proposal(await app(), { pin: SHA('a') });
    const release = hold(WORK.prepare);
    await submit(s, SHA('a'));
    await rt.drain();
    const running = rt.runServices();
    await new Promise((r) => setTimeout(r, 50));
    const end = await send(s, 'AdminEnd', {}, { kind: 'admin' });
    await rt.drain();
    release();
    await running;
    assert.equal((await outcome(end)).state_after, 'failed');
    assert.equal((await row(s.id)).check_error_detail, 'An admin ended the build');
    assert.deepEqual((await workOf(s, WORK.prepare)).map((w) => w.result), [{ cancelled: true }]);
    const notAdmin = await send(s, 'AdminEnd', {}, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(notAdmin)).reason, 'admin_only');

    await send(s, 'RecheckRequested', { reason: 'manual' }, { kind: 'route' });
    await rt.drain();
    await rt.runServices();   // prepare
    await rt.drain();
    assert.equal((await instance(s)).state, 'checking');
    await send(s, 'AdminEnd', {}, { kind: 'admin' });
    await settle();
    const i = await instance(s);
    assert.deepEqual([i.state, i.data.verdict], ['settled', 'error']);
    assert.equal((await row(s.id)).check_error_detail, 'An admin ended the checks run');
    assert.equal((await workOf(s, WORK.cancel)).length, 1, 'its Jobs are cancelled by run id');
  });

  await t.test('P16 who is working on a session: operations recorded, counted while their process lives', async () => {
    const s = await proposal(await app(), { status: 'active' });
    // A process that holds its presence lock, and one that does not.
    const live = await pool.connect();
    await live.query('SELECT pg_advisory_lock($1, hashtext($2) & 2147483647)', [PROCESS_PRESENCE_LOCK, 'live-host']);
    try {
      const op = (id, holder) => send(s, 'OperationStarted', { sessionId: s.id, id, kind: 'sync', holder });
      const first = await op('op:1', 'live-host');
      await rt.drain();
      assert.equal((await outcome(first)).state_after, 'idle', 'an operation on a session never previewed starts its instance');
      await op('op:2', 'dead-host');
      await rt.drain();
      assert.deepEqual((await instance(s)).data.operations.map((o) => o.id), ['op:1', 'op:2']);
      // Idle retirement waits while a live process works on the session.
      await submit(s, SHA('1'));
      await settle();
      const refused = await send(s, 'RetireRequested', { reason: 'idle', terminal: false });
      await rt.drain();
      assert.equal((await outcome(refused)).reason, 'worked_on');
      // The dead holder's record goes at the next record; the live one ends.
      await send(s, 'OperationEnded', { id: 'op:1' });
      await rt.drain();
      assert.deepEqual((await instance(s)).data.operations, [], 'ended, and the dead process\'s record dropped');
      const again = await send(s, 'RetireRequested', { reason: 'idle', terminal: false });
      await rt.drain();
      assert.equal((await outcome(again)).state_after, 'retiring');
      await settle();
      const unknown = await send(s, 'OperationEnded', { id: 'op:9' });
      await rt.drain();
      assert.equal((await outcome(unknown)).reason, 'no_such_operation');
    } finally {
      live.release(true);
    }
  });

  await t.test('P17 the error lane: a platform fault keeps retrying past the cap for a day', async () => {
    const s = await proposal(await app(), { pin: SHA('c') });
    work.answer.set(WORK.prepare, () => ({ ok: false, detail: 'The preview database server refused', platformFault: true }));
    await submit(s, SHA('c'));
    await settle();
    for (let i = 0; i < 7; i++) { await due(s); await rt.fireTimers(); await settle(); }
    const i = await instance(s);
    assert.ok(i.data.streak > 6, 'past the cap of six');
    assert.ok(i.deadline_at, 'still in the lane');
    assert.equal((await row(s.id)).check_error_platform, true);
    work.answer.set(WORK.prepare, prepareOk);
  });
  await t.test('P18 an operation on a session with a serving preview enrols it as it stands, without starting anything', async () => {
    const s = await proposal(await app(), { status: 'active', extra: {
      staging_url: 'https://legacy', staging_runtime_name: 'sv-preview-legacy', staging_runtime_kind: 'kubernetes',
      staging_commit_sha: SHA('a'), checks_commit_sha: SHA('a'), check_state: 'passing' } });
    const live = await pool.connect();
    await live.query('SELECT pg_advisory_lock($1, hashtext($2) & 2147483647)', [PROCESS_PRESENCE_LOCK, 'p18-host']);
    try {
      const id = await send(s, 'OperationStarted', { sessionId: s.id, id: 'op:p18', kind: 'turn', holder: 'p18-host' });
      await rt.drain();
      assert.equal((await outcome(id)).state_after, 'settled');
      const i = await instance(s);
      assert.deepEqual([i.data.serving.n, i.data.verdict, i.data.head], [0, 'passing', SHA('a')]);
      assert.equal((await workOf(s)).length, 0, 'nothing built or run');
      const same = await submit(s, SHA('a'));
      await rt.drain();
      assert.equal((await outcome(same)).reason, 'same_head', 'the head it serves, with its verdict, joins');
      await send(s, 'OperationEnded', { id: 'op:p18' });
      await rt.drain();
      const idle = await send(s, 'RetireRequested', { reason: 'idle', terminal: false });
      await rt.drain();
      assert.equal((await outcome(idle)).state_after, 'retiring', 'an idle reclaim can retire it');
      await settle();
    } finally {
      live.release(true);
    }
  });

  // A person's recheck folded into an operation is owed its run once the
  // session is free: the operation's end looks at once (ChecksDue now), a
  // folded request arms it a minute on. The route's own poll of the session
  // in its process's memory, lost to a restart, is gone.
  await t.test('P18b checks owed while an operation ran are looked at as it ends', async () => {
    const s = await proposal(await app(), { pin: SHA('c') });
    await submit(s, SHA('c'));
    await settle();
    assert.equal((await instance(s)).state, 'settled');
    const live = await pool.connect();
    await live.query('SELECT pg_advisory_lock($1, hashtext($2) & 2147483647)', [PROCESS_PRESENCE_LOCK, 'p18b-host']);
    try {
      await send(s, 'OperationStarted', { sessionId: s.id, id: 'op:p18b', kind: 'sync', holder: 'p18b-host' });
      await rt.drain();
      await pool.query('UPDATE chat_sessions SET unit_suite_fresh_sha = $2 WHERE id = $1', [s.id, SHA('c')]);
      await send(s, 'RecheckFolded', { head: SHA('c'), sessionId: s.id }, { kind: 'route', name: 'manual-recheck' });
      await rt.drain();
      let i = await instance(s);
      assert.equal(i.deadline_event.type, 'ChecksDue');
      const inMs = new Date(i.deadline_at).getTime() - Date.now();
      assert.ok(inMs > 50 * 1000 && inMs <= 60 * 1000, `a minute on: ${inMs}`);
      await send(s, 'OperationEnded', { id: 'op:p18b' });
      await rt.drain();
      i = await instance(s);
      assert.equal(i.deadline_event.type, 'ChecksDue');
      assert.ok(new Date(i.deadline_at).getTime() <= Date.now(), 'due at once');
      const before = work.calls.filter((c) => c.kind === WORK.run).length;
      await rt.fireTimers();
      await settle();
      assert.ok(work.calls.filter((c) => c.kind === WORK.run).length > before, 'the owed run started');
    } finally {
      live.release(true);
    }
  });

  await t.test('P28 the end of the last operation that kept a proposal in review moving asks the merge queue', async () => {
    // 21 Oct 2026: an ask that came while a hand-off's check run held its
    // operation was declined as busy, and nothing asked again for four
    // minutes (the queue's sweep).
    const s = await proposal(await app(), { status: 'promoted', pin: SHA('a'), extra: {
      checks_commit_sha: SHA('a'), check_state: 'passing' } });
    const live = await pool.connect();
    await live.query('SELECT pg_advisory_lock($1, hashtext($2) & 2147483647)', [PROCESS_PRESENCE_LOCK, 'p28-host']);
    const op = (id, kind, on = s) => send(on, 'OperationStarted', { sessionId: on.id, id, kind, holder: 'p28-host' });
    // What the end sent the merge queue: each message is an event of its own.
    const end = async (id, on = s) => {
      const e = await send(on, 'OperationEnded', { id });
      await rt.drain();
      const sent = ((await outcome(e)).emitted?.messages || []).filter((m) => m.machine === 'merge-queue');
      return Promise.all(sent.map(async (m) => {
        const { rows: [q] } = await pool.query('SELECT key, type, payload FROM wf_events WHERE id = $1', [m.eventId]);
        return [q.key, q.type, q.payload];
      }));
    };
    try {
      for (const [id, kind] of [['op:a', 'operation'], ['op:b', 'operation'], ['op:h', 'handoff-pipeline'], ['op:t', 'turn']]) await op(id, kind);
      await rt.drain();
      assert.deepEqual(await end('op:h'), [], 'a hand-off\'s pipeline does not keep it moving (session-work.ts NOT_MOVING_KINDS)');
      assert.deepEqual(await end('op:a'), [], 'another operation still keeps it moving');
      const asked = await end('op:b');
      assert.deepEqual(asked, [[`app:${s.app.id}`, 'MergeWanted', { appId: s.app.id, sessionId: s.id, reason: 'operation-ended' }]],
        'the last one asks');
      assert.deepEqual(await end('op:t'), [], 'a worker\'s turn record asks nothing: its journal is the turn');
      // Not in review: nothing to ask for.
      const draft = await proposal(await app(), { status: 'active' });
      await op('op:d', 'operation', draft);
      await rt.drain();
      assert.deepEqual(await end('op:d', draft), []);
    } finally {
      live.release(true);
    }
  });

  await t.test('P18c a folded recheck on a session with no instance yet, its head reading pending, owes a look', async () => {
    const s = await proposal(await app(), { pin: SHA('e') });
    assert.equal(await instance(s), undefined, 'no instance yet');
    await pool.query(`UPDATE chat_sessions SET checks_commit_sha = $2::text, check_state = 'pending', unit_suite_fresh_sha = $2::text WHERE id = $1`, [s.id, SHA('e')]);
    await send(s, 'RecheckFolded', { head: SHA('e'), sessionId: s.id }, { kind: 'route', name: 'manual-recheck' });
    await rt.drain();
    const i = await instance(s);
    assert.ok(i, 'adopted from its row');
    assert.equal(i.deadline_event?.type, 'ChecksDue', 'the checks it owes are looked at');
  });

  await t.test('P19 a retirement retried by an admin still covers every attempt it had', async () => {
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('1'));
    await settle();
    const release = hold(WORK.prepare);
    await submit(s, SHA('2'));
    await rt.drain();
    const running = rt.runServices();
    await new Promise((r) => setTimeout(r, 50));
    work.answer.set(WORK.retire, { closed: false });
    await pool.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = $1`, [s.id]);
    await send(s, 'RetireRequested', { reason: 'archived', terminal: true });
    await rt.drain();
    release();
    await running;
    await settle();
    let i = await instance(s);
    assert.equal(i.state, 'retiring');
    assert.ok(i.data.exit.failed);
    const first = (await workOf(s, WORK.retire))[0].input.attempts.map((a) => a.n).sort();
    work.answer.set(WORK.retire, { closed: true });
    await send(s, 'AdminRetry', {}, { kind: 'admin' });
    await settle();
    const retires = await workOf(s, WORK.retire);
    assert.deepEqual(retires[1].input.attempts.map((a) => a.n).sort(), first, 'the same attempts, the failed one\'s included');
    i = await instance(s);
    assert.equal(i.state, 'retired');
  });

  await t.test('P20 a retirement right after a cancelled build waits for it to stop', async () => {
    // The transition itself, with a lease to wait for: a prepare cancelled by
    // ChecksCleared left its attempt in `retiring`; a terminal retirement
    // then takes it over, and runs only after that prepare can have stopped.
    const m = preview({ maxRetries: 6, retireAfterMs: 90000 });
    const now = new Date('2026-10-14T12:00:00Z');
    const ctx = { machine: MACHINE, key: 'session:1', appId: 1, version: 7, now };
    const data = {
      sessionId: 1, appId: 1, appSlug: 'a', userId: null, seed: 1, head: SHA('3'), trigger: null, last: 1,
      preparing: null, serving: null, run: null, verdict: null, failure: null, platformFault: false, streak: 0,
      firstFailureAt: null, episode: 0, exit: null, pending: null, closedAt: null, operations: [],
      retiring: [{ n: 1, head: SHA('3'), db: 'db1', key: 'retire-attempt:1:v5', cancelled: true }],
    };
    const facts = { session: { status: 'archived' }, app: { id: 1 }, alive: new Set() };
    const event = { id: 9, type: 'RetireRequested', payload: { reason: 'archived', terminal: true }, source: { kind: 'system' } };
    const out = m.entryFor('idle', 'RetireRequested').to({ name: 'idle', data }, event, facts, ctx);
    const retire = out.work.find((w) => w.kind === WORK.retire);
    assert.equal(retire.notBefore.getTime(), now.getTime() + 90000);
    assert.deepEqual(retire.input.attempts.map((a) => a.n), [1], 'the cancelled attempt is covered');
    assert.deepEqual(out.cancel, [{ kind: WORK.retireAttempt, key: 'retire-attempt:1:v5' }], 'its own retirement is taken over');
    assert.deepEqual(out.next.data.exit.attempts.map((a) => a.n), [1], 'kept for a retry');
  });

  await t.test('P21 a skip read from a row a newer run has moved on is refused', async () => {
    const s = await proposal(await app(), { status: 'promoted', pin: SHA('8'), extra: { checks_commit_sha: SHA('8'), check_state: 'pending' } });
    const id = await send(s, 'ChecksSkipped', { sessionId: s.id, head: SHA('9'), reason: 'nothing beyond main', expected: SHA('7') });
    await rt.drain();
    assert.equal((await outcome(id)).reason, 'checks_moved');
    assert.equal((await row(s.id)).check_state, 'pending');
  });
  await t.test('P22 the claim that deployed is the database that serves; the claims before it go', async () => {
    const s = await proposal(await app(), { status: 'active' });
    work.answer.set(WORK.prepare, (input) => ({ ...prepareOk(input), db: input.dbs[1] }));   // the second claim deployed
    await submit(s, SHA('5'));
    await settle();
    work.answer.set(WORK.prepare, prepareOk);
    const i = await instance(s);
    const prepare = (await workOf(s, WORK.prepare))[0];
    assert.equal(prepare.input.dbs.length, 3);
    assert.equal(prepare.input.dbs[0], prepare.input.db);
    assert.equal(new Set(prepare.input.dbs).size, 3, 'one database per claim');
    assert.equal(i.data.serving.db, prepare.input.dbs[1]);
    assert.deepEqual((await workOf(s, WORK.dropClaims)).map((w) => w.input.dbs), [[prepare.input.dbs[0]]],
      'the first claim\'s database goes, the serving one stays');
  });

  await t.test('P23 a recheck whose inputs changed replaces the run going; any other joins it (review finding)', async () => {
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('6'));
    await rt.drain();
    await rt.runServices();   // prepare
    await rt.drain();
    assert.equal((await instance(s)).state, 'checking');
    const first = (await instance(s)).data.run.key;
    const joins = await send(s, 'RecheckRequested', { reason: 'manual' }, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(joins)).state_after, 'checking');
    assert.equal((await instance(s)).data.run.key, first, 'a person\'s recheck joins the run (recorded as owed on its head)');
    const system = await send(s, 'RecheckRequested', { reason: 'stuck-checks-sweep' });
    await rt.drain();
    assert.equal((await outcome(system)).reason, 'run_outstanding');
    const replaces = await send(s, 'RecheckRequested', { reason: 'testing-update' }, { kind: 'system' });
    await rt.drain();
    assert.equal((await outcome(replaces)).state_after, 'checking');
    const i = await instance(s);
    assert.notEqual(i.data.run.key, first, 'a new run, with what the row says now');
    const runs = await workOf(s, WORK.run);
    assert.deepEqual(runs.find((w) => w.work_key === first).result, { cancelled: true });
    assert.equal((await workOf(s, WORK.cancel)).length, 1, 'its Jobs are cancelled by run id');
    await settle();
    assert.equal((await instance(s)).state, 'settled');
  });
});
