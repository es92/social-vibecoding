'use strict';

// Who spends GitHub's hourly budget (services/github-budget.js noteRequest,
// counted by services/github.js for every request it sends).
//
// On 2026-10-09 the bot token's 5,000 requests an hour ran out twice in one
// evening while the App installation had 11,000 left, and GitHub's figures
// could only say how much was used, never by what. Pinned here:
//
//   1. The counter: per credential and resource, per GitHub window, by
//      caller and endpoint; a 304 is free; the window before is kept; the
//      rows are bounded.
//   2. What it did not count: GitHub's `used` less what was used before this
//      process saw the window, less what it counted.
//   3. The caller is read off the async stack, past services/github.js, and
//      the endpoint is the route template, from Octokit and from a raw fetch.
//   4. Reads the bot token answered because the App is not installed on the
//      repository's owner name that owner.
//   5. Admin, Limits says all of it.
//
// Never calls GitHub.
//
// Run with: node --test tests/github-spend.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const budget = require('../src/services/github-budget');
const github = require('../src/services/github');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const NOW = Date.parse('2026-10-09T20:00:00Z');
const inMin = (m) => String(Math.floor((NOW + m * 60 * 1000) / 1000));
const liveReset = (m = 30) => String(Math.floor((Date.now() + m * 60 * 1000) / 1000));

function headers({ limit = 5000, remaining, used, reset = inMin(30), resource = 'core' }) {
  const h = {
    'x-ratelimit-limit': String(limit),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': reset,
    'x-ratelimit-resource': resource,
  };
  if (used !== undefined) h['x-ratelimit-used'] = String(used);
  return h;
}

function withEnv(t, key, value) {
  const prior = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  });
}

// One answered request, as services/github.js recordHeaders reports it: the
// figures recorded, then the request counted.
function sent(credential, { caller = 'tick (services/x.js)', method = 'GET', url = '/repos/{owner}/{repo}/pulls/{pull_number}', status = 200, used, limit = 5000, reset = inMin(30), resource } = {}) {
  const h = headers({ limit, remaining: limit - used, used, reset, resource });
  budget.record(credential, h, { now: NOW });
  budget.noteRequest(credential, { caller, method, url, status, headers: h });
}

function patRow(now = NOW) {
  return budget.snapshot({ now }).credentials.find((r) => r.credential === 'pat' && r.resource === 'core');
}

test.beforeEach(() => budget._resetForTests());

// ─── 1. The counter ─────────────────────────────────────────────────────

test('counts each request by caller and endpoint, most first, with a 304 counted as free', () => {
  budget.record('pat', headers({ remaining: 4000, used: 1000 }), { now: NOW });
  let used = 1000;
  for (let i = 0; i < 5; i += 1) sent('pat', { caller: 'recoverStuckMerges (routes/votes.js)', used: ++used });
  for (let i = 0; i < 2; i += 1) sent('pat', { caller: 'syncOne (services/pr-import-sync.js)', url: '/repos/{owner}/{repo}/compare/{basehead}', used: ++used });
  sent('pat', { caller: 'syncOne (services/pr-import-sync.js)', used: ++used });
  sent('pat', { caller: 'pollMain (services/main-drift-poller.js)', url: '/repos/{owner}/{repo}/branches/{branch}', status: 304, used });

  const spend = patRow().spend;
  assert.equal(spend.counted, 8);
  assert.equal(spend.free, 1);
  assert.deepEqual(spend.callers.map((c) => [c.caller, c.count, c.free]), [
    ['recoverStuckMerges (routes/votes.js)', 5, 0],
    ['syncOne (services/pr-import-sync.js)', 3, 0],
    ['pollMain (services/main-drift-poller.js)', 0, 1],
  ]);
  assert.deepEqual(spend.callers[1].endpoints, [
    { endpoint: 'GET /repos/{owner}/{repo}/compare/{basehead}', count: 2, free: 0 },
    { endpoint: 'GET /repos/{owner}/{repo}/pulls/{pull_number}', count: 1, free: 0 },
  ]);
  assert.equal(spend.otherCallers, null);
  assert.equal(patRow().previousSpend, null);
});

test('each credential and resource is counted on its own', () => {
  sent('pat', { used: 10 });
  sent('installation:Usernode-Bot', { used: 3, limit: 12500 });
  sent('pat', { used: 1, limit: 5000, resource: 'graphql', url: '/graphql', method: 'POST' });
  const rows = budget.snapshot({ now: NOW }).credentials;
  const find = (cred, resource) => rows.find((r) => r.credential === cred && r.resource === resource).spend;
  assert.equal(find('pat', 'core').counted, 1);
  assert.equal(find('pat', 'graphql').counted, 1);
  assert.equal(find('pat', 'graphql').callers[0].endpoints[0].endpoint, 'POST /graphql');
  assert.equal(find('installation:usernode-bot', 'core').counted, 1, 'owner case does not split it');
});

test('a new window starts the count over and keeps the one before; a late answer goes back to it', () => {
  sent('pat', { used: 4990, caller: 'a (x.js)' });
  sent('pat', { used: 3, reset: inMin(90), caller: 'b (x.js)' });
  sent('pat', { used: 4991, caller: 'a (x.js)' });
  const row = budget.snapshot({ now: NOW }).credentials.find((r) => r.credential === 'pat');
  assert.deepEqual(row.spend.callers.map((c) => [c.caller, c.count]), [['b (x.js)', 1]]);
  assert.deepEqual(row.previousSpend.callers.map((c) => [c.caller, c.count]), [['a (x.js)', 2]]);
  assert.equal(row.previousSpend.expired, false);
  assert.equal(budget.snapshot({ now: NOW + 31 * 60 * 1000 }).credentials[0].previousSpend.expired, true);
});

test('a response without figures reached nothing that counts', () => {
  budget.noteRequest('pat', { caller: 'x', headers: null });
  budget.noteRequest('pat', { caller: 'x', headers: {} });
  budget.noteRequest('ghp_secret', { caller: 'x', headers: headers({ remaining: 1, used: 1 }) });
  assert.equal(budget.snapshot({ now: NOW }).credentials.length, 0);
});

test('the rows are bounded: past 200 caller and endpoint pairs, the rest are counted together', () => {
  budget.record('pat', headers({ remaining: 4000 }), { now: NOW });
  for (let i = 0; i < 230; i += 1) sent('pat', { caller: `caller${i} (services/x.js)`, used: 1 + i });
  const spend = patRow().spend;
  assert.equal(spend.counted, 230, 'nothing is dropped');
  assert.equal(spend.callers.length, 12);
  const other = spend.callers.find((c) => c.caller === '(other callers)');
  assert.ok(other, 'the overflow row is the largest');
  assert.equal(other.count, 30);
  assert.equal(spend.otherCallers.callers, 200 - 11);
});

// ─── 2. What it did not count ───────────────────────────────────────────

test('what GitHub counted beyond this process is reported, net of what was used before it looked', () => {
  // This process joins the window with 1,000 already used.
  sent('pat', { used: 1001 });
  sent('pat', { used: 1002 });
  assert.equal(patRow().spend.usedBeforeCounting, 1000);
  assert.equal(patRow().spend.notCounted, 0);
  // Meanwhile something else spends 500.
  sent('pat', { used: 1503 });
  const spend = patRow().spend;
  assert.equal(spend.counted, 3);
  assert.equal(spend.notCounted, 500);
});

test('answers that land out of order do not invent spending', () => {
  sent('pat', { used: 1003 });
  sent('pat', { used: 1001 });
  sent('pat', { used: 1002 });
  const spend = patRow().spend;
  assert.equal(spend.usedBeforeCounting, 1000);
  assert.equal(spend.notCounted, 0);
});

// ─── 3. The caller and the endpoint ─────────────────────────────────────

test('endpoints are route templates, from Octokit and from a literal URL', () => {
  const cases = [
    ['GET', '/repos/{owner}/{repo}/pulls/{pull_number}', 'GET /repos/{owner}/{repo}/pulls/{pull_number}'],
    ['get', 'https://api.github.com/repos/Usernode-Labs/social-vibecoding/issues/4607?per_page=100', 'GET /repos/{owner}/{repo}/issues/{n}'],
    ['GET', '/repos/a/b/git/ref/heads/feature/x', 'GET /repos/{owner}/{repo}/git/ref/{ref}'],
    ['PATCH', '/repos/a/b/git/refs/heads/x', 'PATCH /repos/{owner}/{repo}/git/refs/{ref}'],
    ['GET', '/repos/a/b/contents/src/a/b.js', 'GET /repos/{owner}/{repo}/contents/{path}'],
    ['GET', '/repos/a/b/compare/main...feature', 'GET /repos/{owner}/{repo}/compare/{basehead}'],
    ['GET', `/repos/a/b/commits/${'a'.repeat(40)}`, 'GET /repos/{owner}/{repo}/commits/{sha}'],
    ['GET', '/repos/a/b/branches/main/protection', 'GET /repos/{owner}/{repo}/branches/{branch}/protection'],
    ['POST', '/graphql', 'POST /graphql'],
  ];
  for (const [method, url, want] of cases) assert.equal(budget.endpointOf(method, url), want, url);
});

function rateFetch(answer = () => ({})) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers && (init.headers.authorization || init.headers.Authorization) });
    const { status = 200, body = { number: 9, title: 't', state: 'open' } } = answer(String(url)) || {};
    return new Response(status === 304 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers({ remaining: 4000, used: 1000 + calls.length, reset: liveReset() }) },
    });
  };
  return { calls, fetchImpl };
}

async function octokitWith(token, fetchImpl) {
  const { Octokit } = await import('@octokit/rest');
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  return new Octokit({ auth: token, request: { fetch: fetchImpl }, log });
}

// Named on purpose: these are the callers the counter has to find.
async function sweepStuckProposals() {
  const pr = await github.getPR('usernode-bot', 'demo', 9);
  return pr;
}

async function readOneIssue() {
  const out = await github.fetchPublicIssue('usernode-bot', 'spend-issue', 9);
  return out;
}

test('the caller is the code that asked, past services/github.js, two frames deep', async (t) => {
  withEnv(t, 'GITHUB_BOT_TOKEN', 'bot-token');
  const gh = rateFetch();
  github._setReadClientsForTests({
    appConfigured: true,
    installation: async () => null,
    installationToken: async () => null,
    pat: async () => octokitWith('bot-token', gh.fetchImpl),
  });
  t.after(() => github._setReadClientsForTests(null));

  await sweepStuckProposals();
  const spend = budget.snapshot().credentials.find((r) => r.credential === 'pat').spend;
  assert.equal(spend.counted, 1);
  const [caller] = spend.callers;
  assert.match(caller.caller, /^sweepStuckProposals \(tests\/github-spend\.test\.js\)( ← .+)?$/,
    'getPR in services/github.js is plumbing, not the caller');
  assert.deepEqual(caller.endpoints.map((e) => e.endpoint), ['GET /repos/{owner}/{repo}/pulls/{pull_number}']);
});

test('a raw fetch read is counted against its caller and endpoint too', async (t) => {
  withEnv(t, 'GITHUB_BOT_TOKEN', 'bot-token');
  withEnv(t, 'GITHUB_READS_VIA_APP', 'off');
  const gh = rateFetch();
  const realFetch = global.fetch;
  global.fetch = gh.fetchImpl;
  t.after(() => { global.fetch = realFetch; });

  await readOneIssue();
  const spend = budget.snapshot().credentials.find((r) => r.credential === 'pat').spend;
  assert.equal(spend.counted, 1);
  assert.match(spend.callers[0].caller, /^readOneIssue \(tests\/github-spend\.test\.js\)/);
  assert.equal(spend.callers[0].endpoints[0].endpoint, 'GET /repos/{owner}/{repo}/issues/{n}');
});

test('the counting never breaks the request it describes', async (t) => {
  const gh = rateFetch();
  const octokit = github._instrumentForTests(await octokitWith('t', gh.fetchImpl), 'pat');
  const real = budget.callerFromStack;
  budget.callerFromStack = () => { throw new Error('boom'); };
  t.after(() => { budget.callerFromStack = real; });
  const { data } = await octokit.rest.pulls.get({ owner: 'o', repo: 'r', pull_number: 9 });
  assert.equal(data.number, 9);
});

// ─── 4. Reads without an installation name the owner ────────────────────

test('reads the bot token answered for want of an installation are counted per owner, bounded', () => {
  budget.noteRead('pat', 'no_installation', { owner: 'Usernode-Labs' });
  budget.noteRead('pat', 'no_installation', { owner: 'usernode-labs' });
  budget.noteRead('pat', 'status_404', { owner: 'usernode-bot' });
  budget.noteRead('installation');
  assert.deepEqual(budget.snapshot().reads, {
    installation: 1,
    pat: 3,
    patReasons: { no_installation: 2, status_404: 1 },
    noInstallation: { 'Usernode-Labs': 2 },
  });
  for (let i = 0; i < 30; i += 1) budget.noteRead('pat', 'no_installation', { owner: `owner${i}` });
  const owners = budget.snapshot().reads.noInstallation;
  assert.equal(Object.keys(owners).length, 21);
  assert.equal(owners['(others)'], 11);

  budget._resetForTests();
  budget.noteRead('pat', 'no_installation', { owner: 'constructor' });
  assert.deepEqual(budget.snapshot().reads.noInstallation, { constructor: 1 }, 'any login is just a name');
});

// ─── 5. Admin, Limits says it ───────────────────────────────────────────

test('the sample figures a preview shows carry callers and a missing installation', () => {
  const demo = budget.demoSnapshot({ now: NOW });
  const pat = demo.credentials.find((r) => r.kind === 'pat');
  assert.ok(pat.spend.callers.length >= 3);
  assert.ok(pat.spend.notCounted > 0);
  assert.ok(Object.keys(demo.reads.noInstallation).length >= 1);
});

test('Admin, Limits lists who spent each credential, what it did not count, and the missing installations', () => {
  const src = read('frontend/src/features/admin/admin-limits.tsx');
  const figures = src.slice(src.indexOf('function GithubSpendList('), src.indexOf('function GithubBudgetCard()'));
  const card = src.slice(src.indexOf('function GithubBudgetCard()'), src.indexOf('function LimitsSection()'));
  assert.match(card, /<GithubBudgetFigures data=\{data\} \/>/);
  assert.match(figures, /<GithubSpendList /, 'each credential row lists its spenders');
  assert.match(figures, /id=\{`admin-github-spend-\$\{id\}`\}/);
  assert.match(figures, /AdminUI\./, 'drawn from the AdminUI registry');
  assert.doesNotMatch(figures + card, /<button|<input|method: 'PUT'/, 'nothing on it writes');
  assert.doesNotMatch(figures + card, new RegExp(String.fromCharCode(0x2014)), 'no em dash in the copy');
});

test('the figures render from the sample payload: spenders, what was not counted, the missing installation', () => {
  globalThis.window = globalThis.window || globalThis;
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const mod = loadTsx('frontend/src/features/admin/admin-limits.tsx', {
    stubs: {
      './admin-console.js': { AdminUI: new Proxy({}, { get: (_t, key) => (key === 'btn' || key === 'badge' ? new Proxy({}, { get: () => 'btn' }) : String(key)) }) },
      '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} },
    },
  });
  const data = { ...budget.demoSnapshot({ now: NOW }), demo: true };
  const html = renderToHtml(createElement(mod.GithubBudgetFigures, { data }));
  assert.match(html, /id="admin-github-no-installation"/);
  assert.match(html, /The GitHub App is not installed on Sample-Org, so reads of its repositories use the bot token \(1,490 since this server started\)/);
  assert.match(html, /Reads since this server started: 6,630 through the App, 1,490 with the bot token \(App not installed on the owner: 1,490\)\./);
  assert.match(html, /id="admin-github-spend-pat"/);
  assert.match(html, /Who used this hour: 3,605 sent by this server, 783 by something else/);
  assert.match(html, /data-caller="recoverStuckMerges \(server\.js\)"/);
  assert.match(html, /GET \/repos\/\{owner\}\/\{repo\}\/pulls\/\{pull_number\}/);
  assert.match(html, /GitHub counted 783 more than this server sent/);
  assert.doesNotMatch(html, /admin-github-spend-installation/, 'a credential nobody counted lists nothing');
  assert.doesNotMatch(html, new RegExp(String.fromCharCode(0x2014)));

  const quiet = renderToHtml(createElement(mod.GithubBudgetFigures, { data: { reservePercent: 15, credentials: [], configured: { botToken: true, app: true } } }));
  assert.match(quiet, /id="admin-github-budget-empty"/);
  assert.doesNotMatch(quiet, /admin-github-no-installation|admin-github-spend-/);
});
