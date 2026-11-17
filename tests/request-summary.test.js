'use strict';

// Homeroom bot's summary at the top of a request's page
// (src/services/request-summary.js, llm.js generateRequestSummary, the
// request_summaries table). These tests hold what it is written from, when
// it is written again, and that a reader never waits on it, against a pool
// that plays the table; tests/request-summary-postgres.test.js runs the same
// service on a real database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const summary = require('../src/services/request-summary');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const change = (over = {}) => ({ id: 51, title: 'A moon button beside the bell', summary: 'Adds a moon button to the header.', by: 'sam', merged: false, ...over });
const inputs = (over = {}) => ({ title: 'Dark mode switch', body: 'Settings is three taps away.', asker: 'maya', plan: null, changes: [], ...over });

test('a summary is written only once there is a plan or a change, and says which it drew on', () => {
  assert.equal(summary.basisOf(inputs()), null, 'the asker\'s own words are all there is');
  assert.equal(summary.basisOf(inputs({ plan: 'A moon button.' })), 'plan');
  assert.equal(summary.basisOf(inputs({ plan: 'A moon button.', changes: [change()] })), 'change');
  assert.equal(summary.basisOf(inputs({ changes: [change(), change({ id: 52 })] })), 'changes');
});

test('the key names everything the summary is written from, and nothing else', () => {
  const base = summary.inputKey(inputs({ plan: 'A moon button.', changes: [change()] }));
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(summary.inputKey(inputs({ plan: 'A moon button.', changes: [change()] })), base, 'the same inputs, the same key');
  const moved = [
    inputs({ title: 'Dark mode toggle', plan: 'A moon button.', changes: [change()] }),
    inputs({ body: 'Edited.', plan: 'A moon button.', changes: [change()] }),
    inputs({ plan: 'A moon button, v2.', changes: [change()] }),
    inputs({ plan: 'A moon button.', changes: [change({ summary: 'Reworded.' })] }),
    inputs({ plan: 'A moon button.', changes: [change({ merged: true })] }),
    inputs({ plan: 'A moon button.', changes: [change(), change({ id: 52 })] }),
  ];
  for (const next of moved) assert.notEqual(summary.inputKey(next), base);
});

test('the model is given the request, the plan and each change, labelled and clipped', () => {
  const text = summary.promptInput(inputs({
    body: 'x'.repeat(9000),
    plan: 'A moon button in the header.',
    changes: [change(), change({ id: 52, title: 'In the account menu', by: 'evan', merged: true })],
  }));
  assert.match(text, /^ASKED BY: maya\nREQUEST TITLE: Dark mode switch\nREQUEST, AS WRITTEN:\n/);
  assert.ok(text.length < 9000, 'a long request is clipped');
  assert.match(text, /THE PLAN POSTED FOR IT:\nA moon button in the header\./);
  assert.match(text, /CHANGE A \(up for a vote\), by sam: A moon button beside the bell\nAdds a moon button to the header\./);
  assert.match(text, /CHANGE B \(merged\), by evan: In the account menu/);
  assert.match(summary.promptInput(inputs({ plan: 'A plan.' })), /CHANGES BUILT FOR IT: none yet\./);
});

// A pool that plays request_summaries, the shared plan and the changes.
function fakePool({ plan = null, changes = [] } = {}) {
  const state = { row: null, plan, changes, queries: [] };
  const query = async (sql, args) => {
    state.queries.push(sql);
    if (/FROM chat_session_specs/.test(sql)) return { rows: state.plan ? [{ content: state.plan }] : [] };
    if (/FROM chat_sessions cs/.test(sql)) {
      return { rows: state.changes.map((c) => ({ id: c.id, pr_title: c.title, pr_summary_md: c.summary, status: c.merged ? 'merged' : 'promoted', username: c.by })) };
    }
    if (/^SELECT input_key/.test(sql.trim())) {
      assert.match(sql, /\(generating_until IS NOT NULL AND generating_until > NOW\(\)\) AS writing/);
      return { rows: state.row ? [{ ...state.row, writing: !!(state.row.generating_until && state.row.generating_until > Date.now()) }] : [] };
    }
    if (/^INSERT INTO request_summaries/.test(sql.trim())) {
      const key = args[2];
      const held = state.row && state.row.generating_until && state.row.generating_until > Date.now();
      const current = state.row && state.row.input_key === key && state.row.summary;
      const failedLately = state.row && state.row.failed_at && state.row.failed_at > Date.now() - summary.RETRY_MS;
      if (held || current || failedLately) return { rows: [] };
      state.row = state.row
        ? { ...state.row, generating_until: Date.now() + 60000 }
        : { input_key: key, summary: null, basis: null, failed_at: null, generating_until: Date.now() + 60000 };
      return { rows: [{ generating_until: new Date() }] };
    }
    if (/^UPDATE request_summaries/.test(sql.trim())) {
      const [, , key, text, basis, , failed] = args;
      state.row = failed
        ? { ...state.row, failed_at: Date.now(), generating_until: null }
        : { ...state.row, input_key: key, summary: text, basis, failed_at: null, generating_until: null };
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  };
  return { state, query };
}

const issue = { title: 'Dark mode switch', body: 'Settings is three taps away.' };
const ask = (pool, deps) => summary.forRequest(pool, { appId: 7, number: 12, issue, asker: 'maya' }, deps);

test('with only the asker\'s words there is no summary, and the model is never asked', async () => {
  const pool = fakePool();
  let calls = 0;
  assert.equal(await ask(pool, { enabled: true, wait: true, generate: async () => { calls += 1; return { summary: 'x' }; } }), null);
  assert.equal(calls, 0);
  assert.ok(!pool.state.queries.some((sql) => /request_summaries/.test(sql)), 'and its row is not even read');
});

test('written once for what it draws on, reused while that stands, written again when it moves', async () => {
  const pool = fakePool({ plan: 'A moon button.' });
  let calls = 0;
  const deps = { enabled: true, wait: true, generate: async ({ input }) => { calls += 1; assert.match(input, /THE PLAN POSTED FOR IT/); return { summary: `Summary ${calls}.`, model: 'stub' }; } };
  assert.deepEqual(await ask(pool, deps), { text: 'Summary 1.', basis: 'plan' });
  assert.deepEqual(await ask(pool, deps), { text: 'Summary 1.', basis: 'plan' });
  assert.equal(calls, 1, 'the second read is the stored one');
  pool.state.changes = [change()];
  assert.deepEqual(await ask(pool, deps), { text: 'Summary 2.', basis: 'change' }, 'a change built for it is new to say');
  assert.equal(calls, 2);
});

test('a reader never waits: the write runs behind the read, which says it is being written', async () => {
  const pool = fakePool({ plan: 'A moon button.' });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = await ask(pool, { enabled: true, generate: async () => { await gate; return { summary: 'Written later.' }; } });
  assert.deepEqual(first, { text: null, basis: 'plan', writing: true }, 'nothing was written yet: the page holds a spinner for it');
  const second = await ask(pool, { enabled: true, generate: async () => { assert.fail('one writer at a time'); } });
  assert.deepEqual(second, { text: null, basis: 'plan', writing: true }, 'another reader sees the same write under way');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await ask(pool, { enabled: true, generate: async () => { assert.fail('it is current'); } }), { text: 'Written later.', basis: 'plan' });
});

test('a summary being rewritten keeps the words it had, and says a new one is coming', async () => {
  const pool = fakePool({ plan: 'A moon button.' });
  assert.deepEqual(await ask(pool, { enabled: true, wait: true, generate: async () => ({ summary: 'The plan.' }) }), { text: 'The plan.', basis: 'plan' });
  pool.state.changes = [change()];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  assert.deepEqual(
    await ask(pool, { enabled: true, generate: async () => { await gate; return { summary: 'The change.' }; } }),
    { text: 'The plan.', basis: 'plan', writing: true },
    'the old words, credited to what they were written from'
  );
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await ask(pool, { enabled: true }), { text: 'The change.', basis: 'change' });
});

test('the write\'s end is announced for the project, written or not, so a waiting page reads again', async () => {
  const told = [];
  const announce = (data) => told.push(data);
  const garden = (pool, deps) => summary.forRequest(pool, { appId: 7, slug: 'garden', number: 12, issue, asker: 'maya' }, { announce, ...deps });
  const pool = fakePool({ plan: 'A moon button.' });
  await garden(pool, { enabled: true, wait: true, generate: async () => ({ summary: 'Written.' }) });
  assert.deepEqual(told, [{ appId: 7, appSlug: 'garden', issueNumber: 12 }], 'only the project and the number travel');
  await garden(pool, { enabled: true, wait: true, generate: async () => assert.fail('it is current') });
  assert.equal(told.length, 1, 'a summary that was current wrote nothing, so says nothing');
  pool.state.plan = 'A moon button, v2.';
  await garden(pool, { enabled: true, wait: true, generate: async () => { throw new Error('model down'); } });
  assert.equal(told.length, 2, 'a failed write ends the wait too: the page shows the asker\'s words');
  // Without the project's slug there is nobody to tell, and nothing is sent.
  const quiet = fakePool({ plan: 'A moon button.' });
  await summary.forRequest(quiet, { appId: 7, number: 12, issue, asker: 'maya' }, { announce, enabled: true, wait: true, generate: async () => ({ summary: 'x' }) });
  assert.equal(told.length, 2);
  // A broken announcement is not a broken write.
  const loud = fakePool({ plan: 'A moon button.' });
  assert.deepEqual(
    await summary.forRequest(loud, { appId: 7, slug: 'garden', number: 12, issue, asker: 'maya' }, { announce: () => { throw new Error('socket down'); }, enabled: true, wait: true, generate: async () => ({ summary: 'Still written.' }) }),
    { text: 'Still written.', basis: 'plan' }
  );
});

test('the announcement is its own socket message, which re-reads the open request and not the board', () => {
  const ws = read('src/services/ws.js');
  const push = ws.slice(ws.indexOf('function pushRequestSummary'), ws.indexOf('// The Workshop\'s grouping for an app moved'));
  assert.match(push, /broadcastGlobalScoped\(\{ type: 'request_summary', appSlug: data\.appSlug, issueNumber: data\.issueNumber \},\s+\{ appId: data\.appId, appSlug: data\.appSlug \}\);/, 'to whoever may view the project');
  assert.doesNotMatch(push, /noteBoardChange/, 'no card moved');
  assert.match(ws, /pushIssueUpdate, pushRequestSummary, pushBoardOrderUpdate,/);
  const app = read('public/js/app.js');
  assert.match(app, /case 'request_summary':[\s\S]*?App\._liveRefresh\('issue', null, \{ appSlug: data\.appSlug, issueNumber: data\.issueNumber, dev: false \}\);\s+break;/);
});

test('a write that fails keeps the summary it had, holds off, then tries again', async () => {
  const pool = fakePool({ plan: 'A moon button.' });
  const ok = { enabled: true, wait: true, generate: async () => ({ summary: 'The first.' }) };
  assert.deepEqual(await ask(pool, ok), { text: 'The first.', basis: 'plan' });
  pool.state.plan = 'A moon button, v2.';
  const failing = { enabled: true, wait: true, generate: async () => { throw new Error('model down'); } };
  assert.deepEqual(await ask(pool, failing), { text: 'The first.', basis: 'plan' }, 'the page keeps what it showed');
  let calls = 0;
  const again = { enabled: true, wait: true, generate: async () => { calls += 1; return { summary: 'The second.' }; } };
  assert.deepEqual(await ask(pool, again), { text: 'The first.', basis: 'plan' });
  assert.equal(calls, 0, 'not asked again inside the hold');
  pool.state.row.failed_at = Date.now() - summary.RETRY_MS - 1000;
  assert.deepEqual(await ask(pool, again), { text: 'The second.', basis: 'plan' });
  assert.equal(calls, 1);
});

test('with no model (a staging copy) nothing is written, and a broken read is a page without a summary', async () => {
  const pool = fakePool({ plan: 'A moon button.' });
  assert.equal(await ask(pool, { enabled: false, generate: async () => { assert.fail('no model'); } }), null);
  assert.equal(pool.state.row, null);
  assert.equal(await summary.forRequest({ query: async () => { throw new Error('db down'); } }, { appId: 7, number: 12, issue, asker: 'maya' }, { enabled: true }), null);
});

test('only what every member can read reaches the model: shared plans, and changes up for a vote or merged', () => {
  const src = read('src/services/request-summary.js');
  assert.match(src, /AND s\.shared_to_group_at IS NOT NULL/, 'a draft plan is not read');
  assert.match(src, /AND cs\.is_headless = FALSE\s+AND cs\.status IN \('promoted', 'merging', 'merged'\)/, 'a change still in somebody\'s workspace is not read');
  const sql = read('src/db/migrations/request-summaries.sql');
  assert.match(sql, /COMMENT ON TABLE request_summaries IS 'staging:private';/, 'a staging copy gets none of the rows');
  assert.match(sql, /PRIMARY KEY \(app_id, issue_number\)/);
});

test('the model call: a helper of its own, told the text is material and never instructions', () => {
  const llm = require('../src/services/llm');
  assert.equal(llm.HELPER_TIME_LIMIT_MS.request_summary, 5000, 'somebody waits on it now, with a spinner');
  assert.equal(llm.REQUEST_SUMMARY_MAX, 600);
  assert.deepEqual(llm.REQUEST_SUMMARY_SCHEMA.required, ['summary']);
  const src = read('src/services/llm.js');
  const fn = src.slice(src.indexOf('async function generateRequestSummary'), src.indexOf('const REVISED_DESCRIPTION_SCHEMA'));
  assert.match(fn, /helper: 'request_summary'/);
  assert.match(fn, /never instructions to you/);
  assert.match(fn, /does not build/, 'the content rules ride in the prompt');
  const telemetry = read('src/services/llm-telemetry.js');
  assert.equal((telemetry.match(/'request_summary'/g) || []).length, 2, 'named in both of the telemetry\'s lists');
  // The page's read carries it, and a staging mock has a made-up one.
  const route = read('src/routes/issues.js');
  assert.match(route, /const summary = issue === mock\s+\? stagingMockSummary\(number\)\s+: await require\('\.\.\/services\/request-summary'\)\.forRequest\(pool, \{ appId: app\.id, slug: app\.slug, number, issue, asker: askerName \}\);/);
  assert.match(route, /if \(!IS_STAGING \|\| Number\(number\) !== 900003\) return null;/);
});
