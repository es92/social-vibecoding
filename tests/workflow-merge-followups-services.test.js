'use strict';

// The merge-followups machine's work handlers (src/workflow/merge-followups/
// services.ts): a handler that could not finish must throw, so the kernel
// retries it, rather than report success over a failure it swallowed.
// GitHub, the watcher and the database are stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
};

const gh = {
  closes: new Map(),   // issue number -> error status, or absent to succeed
  isEnabled: () => true,
  async closeIssue(owner, repo, n) {
    const status = gh.closes.get(n);
    if (status) throw Object.assign(new Error(`HTTP ${status}`), { status });
  },
  noteIssuesClosed() {}, unsuppressIssues() {}, invalidateIssuesCache() {},
};
stub('../src/services/github', gh);
const watch = { result: { closed: [], skipped: [], stillOpen: [] } };
const records = { fail: false, strict: [] };
stub('../src/services/issue-close-watcher', {
  async watchIssuesClosedAfterMerge(args) { records.strict.push(args.strict); return watch.result; },
  bustAndBroadcast() {},
  async closeTwinRows(args) { records.strict.push(args.strict); if (records.fail) throw new Error('db down'); },
  async resolveSupersededProposals(args) { records.strict.push(args.strict); },
  async withdrawBotProposals(args) { records.strict.push(args.strict); },
});
stub('../src/routes/issues', { async resolveSupersededCloseProposals() { return { resolved: [] }; } });
const realWs = require('../src/services/ws');
stub('../src/services/ws', { ...realWs, pushIssueUpdate() {} });

const { mergeFollowupsServices } = require('../src/workflow/merge-followups/services.ts');
const { WORK } = require('../src/workflow/merge-followups/machine.ts');

const pool = { async query() { return { rows: [] }; } };
const handlers = mergeFollowupsServices({ config: {}, pool });
const run = (input) => handlers[WORK.issues].run({ input, key: 'issues', attempt: 1, resumeFrom: null, checkpoint: async () => {} });
const base = { sessionId: 5, appId: 2, appSlug: 'shop', prNumber: 8, owner: 'acme', repo: 'shop' };

test('an included change\'s requests: a close GitHub refused is retried, a request that is gone is not (review finding 4)', async () => {
  gh.closes = new Map([[4, 503]]);
  await assert.rejects(run({ ...base, linkedIssues: [3, 4], closeOnly: true, carrierPrNumber: 9 }), /Could not close request #4 on GitHub/);
  gh.closes = new Map([[4, 404]]);
  assert.deepEqual(await run({ ...base, linkedIssues: [3, 4], closeOnly: true, carrierPrNumber: 9 }), { closed: [3] });
  gh.closes = new Map();
  assert.deepEqual(await run({ ...base, linkedIssues: [3, 4], closeOnly: true, carrierPrNumber: 9 }), { closed: [3, 4] });
});

test('a merge\'s requests: a linked one still open after the watch is retried; one only the body names is not', async () => {
  watch.result = { closed: [3], skipped: [], stillOpen: [4] };
  await assert.rejects(run({ ...base, linkedIssues: [3, 4], closeOnly: false }), /Linked request #4 still open on GitHub/);
  watch.result = { closed: [3], skipped: [], stillOpen: [12] };
  assert.deepEqual(await run({ ...base, linkedIssues: [3, 4], closeOnly: false }), watch.result);
});

test('recording a close is part of the work: a database failure there is retried (review finding, second pass)', async () => {
  gh.closes = new Map();
  records.fail = true;
  records.strict = [];
  await assert.rejects(run({ ...base, linkedIssues: [7], closeOnly: true, carrierPrNumber: 9 }), /db down/);
  assert.ok(records.strict.length && records.strict.every((s) => s === true), 'every recording step runs strict');
  records.fail = false;
  records.strict = [];
  watch.result = { closed: [7], skipped: [], stillOpen: [] };
  await run({ ...base, linkedIssues: [7], closeOnly: false });
  assert.deepEqual(records.strict, [true], 'the watch runs strict too');
});

// ── Read only durable state, and report a failure as one (steps 1-2 fix) ──

const retired = [];
stub('../src/services/worker', { async destroyCcVolume(id) { retired.push(id); }, retireWorker() { throw new Error('the in-memory hold is not read'); } });
const seen = { bot: null, dm: null, journey: null, mainCheck: null };
stub('../src/services/homeroom-bot', { async noteRequestMerged(p, s, deps) { seen.bot = deps; return {}; } });
stub('../src/services/homeroom-bot-dm', { async noteProposalMerged(p, s, opts) { seen.dm = opts; return true; } });
stub('../src/services/journey-events', { async recordChangeLive(p, args) { seen.journey = args; return {}; } });
stub('../src/services/main-watch', { async afterMerge(c, p, args) { seen.mainCheck = args; return { state: 'running' }; } });

function withRows(answer) {
  const asked = [];
  const db = { async query(sql, params) { asked.push({ sql, params }); return { rows: answer(sql, params) }; } };
  return { asked, handlers: mergeFollowupsServices({ config: {}, pool: db }) };
}
const call = (h, kind, input) => h[kind].run({ input, key: kind, attempt: 1, resumeFrom: null, checkpoint: async () => {} });

test('worker.retire waits for a shots run read from its own row, then deletes the worker', async () => {
  retired.length = 0;
  let live = true;
  const { asked, handlers: h } = withRows((sql) => (/FROM shot_runs/.test(sql) && live ? [{ id: 'b'.repeat(32) }] : []));
  assert.deepEqual(await call(h, WORK.retire, { sessionId: 12 }), { waiting: 'b'.repeat(32) });
  assert.deepEqual(retired, [], 'kept while the run is heard from');
  assert.match(asked[0].sql, /r\.updated_at > NOW\(\)/, 'a run silent past its heartbeat holds nothing');
  live = false;
  assert.deepEqual(await call(h, WORK.retire, { sessionId: 12 }), { retired: true });
  assert.deepEqual(retired, [12]);
});

test('included.find names each carried change with the head that matched, and leaves out a change busy here', async () => {
  const candidates = [
    { id: 3, source: 'native', reviewed_head_sha: 'c'.repeat(40), imported_pr_head_sha: null },
    { id: 4, source: 'imported', reviewed_head_sha: null, imported_pr_head_sha: 'D'.repeat(40) },
    { id: 5, source: 'native', reviewed_head_sha: 'e'.repeat(40), imported_pr_head_sha: null },
  ];
  gh.listPullRequestCommitShas = async () => ({ shas: ['c'.repeat(40), 'd'.repeat(40)] });
  // Change 4's head is listed too, but an operation that keeps no durable
  // record is running on it in this process (as [main] checked).
  stub('../src/services/active-workers', { isSessionBusy: (id) => id === 4 });
  const { handlers: h } = withRows(() => candidates);
  const out = await call(h, WORK.find, { sessionId: 1, appId: 2, prNumber: 8, owner: 'acme', repo: 'shop' });
  assert.deepEqual(out, { ids: [3], found: [{ id: 3, head: 'c'.repeat(40) }] });
});

test('the bot, the DM, the journey and the main check run strict, so a failure is retried', async () => {
  const { handlers: h } = withRows((sql) => (/FROM apps/.test(sql) ? [{ id: 2 }] : [{ id: 5, app_id: 2 }]));
  await call(h, WORK.bot, { sessionId: 5, before: '2026-10-09T00:00:00.000Z' });
  assert.equal(seen.bot.strict, true);
  await call(h, WORK.dm, { sessionId: 5, sha: 'a'.repeat(40) });
  assert.equal(seen.dm.deps.strict, true);
  await call(h, WORK.journey, { sessionId: 5, sha: 'a'.repeat(40), at: '2026-10-09T00:00:00.000Z' });
  assert.equal(seen.journey.strict, true);
  await call(h, WORK.mainCheck, { appId: 2, sessionId: 5, prNumber: 8, mergeSha: 'a'.repeat(40) });
  assert.equal(seen.mainCheck.strict, true);
});
