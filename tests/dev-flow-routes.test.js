// The browser's door into the external-agent flow (#1049).
//
// src/routes/dev-flow.js is deliberately thin: prepareWork / submitWork /
// inspectFork / inspectPushedBranch already existed and are covered by
// tests/external-agent-tasks.test.js. What is NEW here — and what this file
// pins — is the transport around them:
//
//   1. GET /api/apps/:slug/dev-flow/status answers every step of the
//      walkthrough in one request, and degrades a step at a time. A missing
//      repository, a GitHub App that is off, an unlinked account and a
//      branch read that throws each produce a renderable payload, never a
//      500 and never a half-answer.
//   2. The picked agent round-trips as `usernode-web:<agent>` on client_id,
//      which is what makes reopening the chat resume the same work order.
//      Only the two real products are pickable.
//   3. Both writes are cookie-authenticated mutations that spend a
//      rate-limit slot and can open a pull request, so they carry the
//      same-origin check — refused BEFORE the service is reached.
//   4. Every failure code the service layer can emit has an HTTP status.
//      This is scraped from the service sources, so a new code in
//      external-agent-tasks.js fails here instead of silently answering 400.
//
// Run with: node --test tests/dev-flow-routes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── Stubs, installed before the router is built ─────────────────────────

const poolMod = require('../src/db/pool');
let poolCalls = [];
poolMod.getPool = () => ({
  async query(sql, params) {
    poolCalls.push({ sql, params });
    // The only query the route itself makes: the advisory connector count.
    return { rows: [{ n: 2 }] };
  },
});

const appAccess = require('../src/services/app-access');
const svc = require('../src/services/external-agent-tasks');
const githubLink = require('../src/services/github-link');
const gh = require('../src/services/github');

const APP = { id: 7, slug: 'recipe-box', name: 'Recipe Box', repo_url: 'https://github.com/usernode-apps/recipe-box' };
const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const ORIGIN = 'https://usernode.example';
const CONFIG = { cliAuthOrigin: ORIGIN, port: 4321 };

// Every stub is reset in beforeEach; a test overrides only what it needs.
let stub;
function resetStubs() {
  poolCalls = [];
  stub = {
    app: APP,
    ghEnabled: true,
    linkEnabled: true,
    link: { linked: true, login: 'octo-contributor' },
    fork: { state: 'ready', fork: { name: 'recipe-box' } },
    task: null,
    branchState: 'pushed',
    branchThrows: false,
    prepare: { ok: true, taskId: 4242, agent: 'claude-code', reused: false },
    submit: { ok: true, proposalId: 91, submittedVia: 'pull_request' },
    prepareArgs: null,
    submitArgs: null,
  };
}

appAccess.getAppForUser = async () => stub.app;
gh.isEnabled = () => stub.ghEnabled;
gh.parseGithubUrl = (url) => {
  const m = /github\.com\/([^/]+)\/([^/.]+)/.exec(url || '');
  return m ? { owner: m[1], repo: m[2] } : null;
};
githubLink.isEnabled = () => stub.linkEnabled;
githubLink.linkStatus = async () => stub.link;
svc.inspectFork = async () => stub.fork;
svc.loadLatestOpenTaskForSlug = async () => stub.task;
svc.inspectPushedBranch = async () => {
  if (stub.branchThrows) throw new Error('github said no');
  return stub.branchState;
};
svc.prepareWork = async (_deps, args) => { stub.prepareArgs = args; return stub.prepare; };
svc.submitWork = async (_deps, args) => { stub.submitArgs = args; return stub.submit; };

const { devFlowRoutes, PICKABLE_AGENTS, STATUS_BY_CODE, shapeBranch } = require('../src/routes/dev-flow');

let server, base;
let user = null;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(devFlowRoutes(CONFIG));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  // closeAllConnections first — undici holds the sockets open and a bare
  // close() would wait on them (see tests/dev-flow-preference.test.js).
  if (!server) return;
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close();
});

test.beforeEach(() => {
  resetStubs();
  user = { id: 42, username: 'tester', isAdmin: false };
});

const status = (qs = '') => fetch(`${base}/api/apps/recipe-box/dev-flow/status${qs}`);
const post = (url, body, headers = {}) => fetch(`${base}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const prepare = (body, headers) => post('/api/apps/recipe-box/external-tasks', body, headers);
const submit = (id, body, headers) => post(`/api/apps/recipe-box/external-tasks/${id}/submit`, body || {}, headers);

function openTask(over) {
  return Object.assign({
    id: 4242,
    client_id: 'usernode-web:codex',
    branch_name: 'usernode/add-a-button',
    base_sha: BASE_SHA,
    fork_owner: 'octo-contributor',
    fork_repo: 'recipe-box',
    issue_number: null,
    brief: 'Add a button.',
  }, over || {});
}

// ── 1. Authentication and app access ────────────────────────────────────

test('all three routes are 401 without a session', async () => {
  user = null;
  for (const r of [await status(), await prepare({ agent: 'codex', brief: 'x' }), await submit(1)]) {
    assert.equal(r.status, 401);
  }
  assert.equal(stub.prepareArgs, null, 'the service is never reached');
  assert.equal(stub.submitArgs, null);
});

test('an app the user cannot collaborate on is a 404 on all three', async () => {
  stub.app = null;
  for (const r of [await status(), await prepare({ agent: 'codex', brief: 'x' }), await submit(1)]) {
    assert.equal(r.status, 404);
  }
  assert.equal(stub.prepareArgs, null, 'access is resolved before any work is prepared');
});

// ── 2. Status: the walkthrough's state ──────────────────────────────────

test('an app with no repository reports why, instead of failing', async () => {
  // Every unavailable branch still returns 200 with a `reason` the client
  // has copy for — the walkthrough explains itself rather than erroring.
  stub.app = { ...APP, repo_url: null };
  const r = await status();
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.available, false);
  assert.equal(j.reason, 'no_repository');
  assert.deepEqual([j.fork, j.task, j.branch], [null, null, null]);
});

test('the two "the platform cannot do this" reasons are distinguished', async () => {
  stub.ghEnabled = false;
  assert.equal((await (await status()).json()).reason, 'platform_unavailable');

  stub.ghEnabled = true;
  stub.linkEnabled = false;
  const j = await (await status()).json();
  assert.equal(j.reason, 'link_unavailable');
  assert.equal(j.github.available, false,
    'the GitHub step must show as unavailable, not merely unlinked');
});

test('an unlinked account stops at step 1 without touching GitHub', async () => {
  stub.link = { linked: false, login: null };
  let inspected = false;
  const realInspect = svc.inspectFork;
  svc.inspectFork = async () => { inspected = true; return stub.fork; };
  try {
    const j = await (await status()).json();
    assert.equal(j.available, true, 'the flow itself is available — the user just has a step to do');
    assert.deepEqual(j.github, { linked: false, login: null, available: true });
    assert.deepEqual([j.fork, j.task, j.branch], [null, null, null]);
    assert.equal(inspected, false, 'there is no login to inspect a fork for');
  } finally {
    svc.inspectFork = realInspect;
  }
});

test('a linked account with no work order reports the fork and stops there', async () => {
  const j = await (await status()).json();
  assert.equal(j.available, true);
  assert.deepEqual(j.repo, { owner: 'usernode-apps', repo: 'recipe-box' });
  assert.equal(j.github.login, 'octo-contributor');
  assert.equal(j.fork.state, 'ready');
  assert.equal(j.fork.owner, 'octo-contributor');
  assert.equal(j.fork.url, 'https://github.com/octo-contributor/recipe-box');
  assert.equal(j.fork.pageUrl, 'https://github.com/usernode-apps/recipe-box/fork',
    'the "create a fork" link must point at the UPSTREAM repo');
  assert.equal(j.task, null);
  assert.equal(j.branch, null);
  assert.equal(j.connectors.count, 2, 'the advisory connector count comes from the pool');
});

test('an unreadable fork is "unknown", and a name conflict keeps its suffix', async () => {
  stub.fork = { state: 'unknown' };
  assert.equal((await (await status()).json()).fork.state, 'unknown',
    'a failed read must not assert the user has no fork');

  stub.fork = { state: 'name_conflict' };
  const j = await (await status()).json();
  assert.equal(j.fork.state, 'name_conflict');
  assert.equal(j.fork.repo, `recipe-box${svc.CONFLICT_FORK_SUFFIX}`,
    'the walkthrough must name the fork the service will actually use');
});

test('an open work order is re-rendered from its stored values', async () => {
  // This is what makes the walkthrough resumable: the branch and base commit
  // come off the row, so closing the tab and coming back shows the SAME work
  // order rather than preparing a second one.
  stub.task = openTask();
  let renderArgs = null;
  const realRender = svc.renderPreparedTask;
  svc.renderPreparedTask = (args) => {
    renderArgs = args;
    return realRender({ ...args, prompts: require('../src/services/prompts') });
  };
  try {
    const j = await (await status()).json();
    assert.equal(renderArgs.reused, true);
    assert.equal(renderArgs.clientId, 'usernode-web:codex',
      'the stored client id is what carries the picked agent');
    assert.equal(renderArgs.origin, ORIGIN, 'links are stamped with the canonical origin');
    assert.equal(renderArgs.forkStatus, 'ready');

    assert.equal(j.task.id, 4242);
    assert.equal(j.task.agent, 'codex', 'the agent survives a reload with no column of its own');
    assert.equal(j.task.branch, 'usernode/add-a-button');
    assert.equal(j.task.baseSha, BASE_SHA);
    assert.equal(j.task.brief, 'Add a button.');
    assert.ok(j.task.workOrder.length > 0, 'the work order is ready to paste');
    assert.ok(Array.isArray(j.task.guidance) && j.task.guidance.length > 0);
    assert.deepEqual(j.branch, { state: 'pushed', pushed: true, unpushed: false, missing: false });
  } finally {
    svc.renderPreparedTask = realRender;
  }
});

test('a branch read that throws leaves the step unknown, not the request failed', async () => {
  // GitHub being briefly unreadable must not blank the work order the user
  // is in the middle of — the last step just cannot answer yet.
  stub.task = openTask();
  stub.branchThrows = true;
  const r = await status();
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.task.id, 4242, 'the work order is still delivered');
  assert.deepEqual(j.branch, { state: 'unknown', pushed: false, unpushed: false, missing: false });
});

test('shapeBranch answers the three questions the walkthrough asks', () => {
  assert.deepEqual(shapeBranch('pushed'), { state: 'pushed', pushed: true, unpushed: false, missing: false });
  assert.deepEqual(shapeBranch('unpushed'), { state: 'unpushed', pushed: false, unpushed: true, missing: false });
  assert.deepEqual(shapeBranch('missing'), { state: 'missing', pushed: false, unpushed: false, missing: true });
  // Anything else is "we don't know" — never accidentally truthy.
  for (const s of ['unknown', '', null, undefined]) {
    const shaped = shapeBranch(s);
    assert.equal(shaped.pushed || shaped.unpushed || shaped.missing, false, `${s} asserts nothing`);
  }
});

test('an unexpected throw is a 500, not a half-rendered payload', async () => {
  const real = appAccess.getAppForUser;
  appAccess.getAppForUser = async () => { throw new Error('database is on fire'); };
  try {
    const r = await status();
    assert.equal(r.status, 500);
    assert.doesNotMatch(JSON.stringify(await r.json()), /on fire/,
      'the internal message must not be echoed to the browser');
  } finally {
    appAccess.getAppForUser = real;
  }
});

// ── 3. Prepare ──────────────────────────────────────────────────────────

test('only the two real products are pickable', async () => {
  assert.deepEqual(PICKABLE_AGENTS, ['claude-code', 'codex']);
  for (const agent of ['external', 'claude', 'CODEX', '', null, 42, ['codex']]) {
    const r = await prepare({ agent, brief: 'Add a button.' });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(agent)}`);
    assert.equal((await r.json()).code, 'invalid_request');
    assert.equal(stub.prepareArgs, null, 'no slot is spent on an unpickable agent');
  }
});

test('a work order needs something to say', async () => {
  for (const body of [{ agent: 'codex' }, { agent: 'codex', brief: '   ' }, { agent: 'codex', issueNumber: 0 }]) {
    const r = await prepare(body);
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(stub.prepareArgs, null);
  }
  // An issue number alone is enough — the brief comes from the issue.
  const ok = await prepare({ agent: 'codex', issueNumber: 12 });
  assert.equal(ok.status, 200);
  assert.equal(stub.prepareArgs.issueNumber, 12);
});

test('the picked agent is recorded on the row as usernode-web:<agent>', async () => {
  for (const agent of PICKABLE_AGENTS) {
    const r = await prepare({ agent, brief: 'Add a button.' });
    assert.equal(r.status, 200);
    assert.equal(stub.prepareArgs.agent, agent, 'the explicit choice is passed through, not sniffed');
    assert.equal(stub.prepareArgs.clientId, `usernode-web:${agent}`);
    assert.equal(stub.prepareArgs.origin, ORIGIN);
    // And that stamp is exactly what the status route reads back.
    assert.equal(svc.normalizeAgent(null, stub.prepareArgs.clientId), agent);
  }
});

test('restart is a boolean the caller cannot smuggle a value through', async () => {
  await prepare({ agent: 'codex', brief: 'x', restart: 'yes please' });
  assert.equal(stub.prepareArgs.restart, true);
  await prepare({ agent: 'codex', brief: 'x' });
  assert.equal(stub.prepareArgs.restart, false);
});

// ── 4. Submit ───────────────────────────────────────────────────────────

test('a task id that is not a positive integer is refused', async () => {
  for (const id of ['abc', '0', '-3', '1.5.2']) {
    const r = await submit(id);
    assert.equal(r.status, 400, `expected 400 for ${id}`);
    assert.equal(stub.submitArgs, null);
  }
});

test('submit hands the service a loopback import that replays the caller\'s session', async () => {
  // The import must run through the browser's OWN pr-import route so the
  // proposal is attributed to the user and gets the same announcement and
  // staging build — and it must not be able to leave the box.
  const r = await fetch(`${base}/api/apps/recipe-box/external-tasks/4242/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: 'session=abc123' },
    body: JSON.stringify({ title: 'Add a button' }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), stub.submit);
  assert.equal(stub.submitArgs.taskId, 4242);
  assert.equal(stub.submitArgs.source, 'web');
  assert.equal(stub.submitArgs.title, 'Add a button');
  assert.equal(typeof stub.submitArgs.importProposal, 'function');

  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return { ok: true, status: 200, async text() { return '{"proposalId":91}'; } };
  };
  try {
    const out = await stub.submitArgs.importProposal('recipe-box', 5);
    assert.deepEqual(out, { ok: true, status: 200, body: { proposalId: 91 } });
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://127.0.0.1:4321/api/apps/recipe-box/pr-import',
    'loopback only: 127.0.0.1 and this process\'s own port');
  assert.equal(seen[0].opts.headers.cookie, 'session=abc123',
    'the caller\'s own session is replayed, so the import is attributed to them');
  assert.equal(seen[0].opts.body, '{"pr":5}');
});

test('an import that cannot be reached is reported, not thrown', async () => {
  await submit(4242);
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const out = await stub.submitArgs.importProposal('recipe-box', 5);
    assert.deepEqual(out, { ok: false, status: 0, body: null, networkError: true });
  } finally {
    global.fetch = realFetch;
  }
});

// ── 5. Failure mapping ──────────────────────────────────────────────────

test('every failure code the service layer can emit has an HTTP status', () => {
  // Scraped, not listed: a new fail() in the service must either be mapped
  // here or fail this test. An unmapped code answers 400, which tells a
  // client "your request was wrong" for what may be a 429 or a 502.
  const emitted = new Set();
  for (const src of ['src/services/external-agent-tasks.js', 'src/services/connector-limits.js']) {
    const text = read(src);
    for (const m of text.matchAll(/(?:fail|limitError)\(\s*'([a-z_]+)'/g)) emitted.add(m[1]);
    for (const m of text.matchAll(/\bcode:\s*'([a-z_]+)'/g)) emitted.add(m[1]);
  }
  assert.ok(emitted.size >= 10, `expected to scrape a real set of codes, got ${emitted.size}`);
  for (const code of emitted) {
    assert.ok(STATUS_BY_CODE[code], `${code} has no HTTP status in STATUS_BY_CODE`);
  }
  // And nothing mapped that no longer exists — a stale key is a claim the
  // route makes about the service that is not true any more.
  for (const code of Object.keys(STATUS_BY_CODE)) {
    assert.ok(emitted.has(code), `STATUS_BY_CODE maps '${code}', which nothing emits`);
  }
});

test('a service failure keeps its own wording and gets the right status', async () => {
  const cases = [
    ['github_not_linked', 409],
    ['at_capacity', 429],
    ['platform_unavailable', 503],
    ['import_failed', 502],
    ['unknown_task', 404],
    ['no_access', 403],
    ['not_a_real_code', 400],
  ];
  for (const [code, expected] of cases) {
    stub.prepare = { ok: false, code, message: `wording for ${code}`, retryable: true, settingsUrl: '/settings' };
    const r = await prepare({ agent: 'codex', brief: 'x' });
    assert.equal(r.status, expected, `${code} → ${expected}`);
    const j = await r.json();
    assert.equal(j.error, `wording for ${code}`, 'the service writes the copy, not the route');
    assert.equal(j.code, code, 'the code reaches the client, which branches on it');
    assert.equal(j.retryable, true);
    assert.equal(j.settingsUrl, '/settings');
  }
  // submitWork's failures go through the same mapping.
  stub.submit = { ok: false, code: 'no_commits', message: 'Push it first.' };
  assert.equal((await submit(4242)).status, 409);
});

// ── 6. Same-origin ──────────────────────────────────────────────────────

test('a cross-origin write is refused before the service is reached', async () => {
  for (const headers of [
    { origin: 'https://evil.example' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ]) {
    const p = await prepare({ agent: 'codex', brief: 'x' }, headers);
    assert.equal(p.status, 403, `prepare refuses ${JSON.stringify(headers)}`);
    const s = await submit(4242, {}, headers);
    assert.equal(s.status, 403, `submit refuses ${JSON.stringify(headers)}`);
    assert.equal(stub.prepareArgs, null, 'no rate-limit slot is spent');
    assert.equal(stub.submitArgs, null, 'no pull request is opened');
  }
});

test('the platform\'s own origin is allowed through', async () => {
  const ok = await prepare({ agent: 'codex', brief: 'x' }, { origin: ORIGIN, 'sec-fetch-site': 'same-origin' });
  assert.equal(ok.status, 200);
  assert.equal(stub.prepareArgs.agent, 'codex');
});

test('the read is not gated on origin', async () => {
  // Polling status is a plain authenticated GET; gating it would break the
  // "check again" button behind any browser that sends sec-fetch-site.
  const r = await fetch(`${base}/api/apps/recipe-box/dev-flow/status`, {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(r.status, 200);
});

// ── 7. Wiring and staging ───────────────────────────────────────────────

test('the routes are mounted, and behind the global API auth gate', () => {
  const serverSrc = read('server.js');
  assert.match(serverSrc, /devFlowRoutes\b/);
  assert.match(serverSrc, /app\.use\(devFlowRoutes\(config\)\)/);
  const authIdx = serverSrc.indexOf('app.use(authMiddleware');
  const mountIdx = serverSrc.indexOf('app.use(devFlowRoutes(config))');
  assert.ok(authIdx > 0 && authIdx < mountIdx,
    'the /api/* auth middleware must be installed before these routes');
});

test('staging never reaches GitHub, and only shows fixtures when asked', () => {
  // The #555 convention: gated on USERNODE_ENV === 'staging' AND a
  // request-time ?demo=1, obviously fake, written nowhere. A staging clone
  // has no GitHub OAuth app, so without the fixture there is nothing to
  // review; with it, the walkthrough renders at its most interesting step.
  const src = read('src/routes/dev-flow.js');
  assert.match(src, /const IS_STAGING = process\.env\.USERNODE_ENV === 'staging'/);
  assert.match(src, /req\.query\.demo === '1'\s*\n?\s*\? demoStatus/,
    'the fixture is opt-in per request');
  assert.match(src, /990501/, 'fixture ids stay in the obviously-fake 99xxxx range');
  // Both writes are refused in staging: they would open a real pull request
  // against a real repository from a preview clone.
  const prepareBlock = src.slice(src.indexOf("router.post('/api/apps/:slug/external-tasks'"));
  assert.equal((prepareBlock.match(/if \(IS_STAGING\) \{\s*\n\s*return res\.status\(503\)/g) || []).length, 2,
    'both POSTs refuse in staging with a 503');
});

test('the client polls this route and nothing else', () => {
  const devChat = read('public/js/dev-chat.js');
  assert.match(devChat, /dev-flow\/status/, 'the walkthrough reads its state from the status route');
  assert.match(devChat, /external-tasks/, 'and prepares/submits through the same pair');
  // The renderer stays pure — see tests/dev-flow-select.test.js.
  assert.ok(!/\bfetch\s*\(/.test(read('public/js/dev-flow-select.js')),
    'public/js/dev-flow-select.js must not fetch; the dev chat owns the I/O');
});
