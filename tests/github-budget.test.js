'use strict';

// GitHub's hourly REST budget (services/github-budget.js).
//
// On 2026-10-04 the bot token's 5,000 requests an hour ran out: new
// proposals failed with "Homeroom could not read the app's current code" and
// before/after shots with "Cannot bootstrap worker ... API rate limit
// exceeded", and nothing had said the budget was running low. Pinned here:
//
//   1. The recorder: the headers of every response, success or error, per
//      credential; out-of-order responses; a window that has reset.
//   2. budgetAllows('background'): held under the reserve while the reset
//      is ahead, one log line per window, never for anything else.
//   3. The plain-words notice, for an error and for its absence.
//   4. The wiring in services/github.js: both Octokit clients and the raw
//      fetch paths record, and checkRepoPublic says what happened.
//   5. The background callers that ask, and the admin read.
//
// Never calls GitHub: Octokit gets a fake fetch, the raw paths a stubbed
// global fetch.
//
// Run with: node --test tests/github-budget.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const loggerId = require.resolve('../src/services/logger');
const warned = [];
require.cache[loggerId] = {
  id: loggerId,
  filename: loggerId,
  loaded: true,
  paths: [],
  exports: {
    info() {}, debug() {}, error() {},
    warn: (...args) => warned.push(args),
  },
};

const budget = require('../src/services/github-budget');
const github = require('../src/services/github');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const NOW = Date.parse('2026-10-04T15:00:00Z');
const inMin = (m) => String(Math.floor((NOW + m * 60 * 1000) / 1000));
// For a response recorded through the real wiring (an instrumented Octokit,
// the raw fetch reads): those record and read at the real clock, so their
// reset has to be ahead of the real clock too. A reset pinned to NOW passes
// in real time, and the reading then counts as a whole new window.
const liveReset = (m = 30) => String(Math.floor((Date.now() + m * 60 * 1000) / 1000));

function headers({ limit = 5000, remaining, reset = inMin(30), used, resource = 'core' }) {
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

test.beforeEach(() => {
  budget._resetForTests();
  warned.length = 0;
});

// ─── 1. The recorder ────────────────────────────────────────────────────

test('records each credential on its own, from Octokit headers and from a fetch Headers', () => {
  budget.record('pat', headers({ remaining: 4200, used: 800 }), { now: NOW });
  budget.record('installation:Usernode-Labs', new Headers(headers({ limit: 12500, remaining: 12400 })), { now: NOW });

  const pat = budget.core('pat', { now: NOW });
  assert.equal(pat.limit, 5000);
  assert.equal(pat.remaining, 4200);
  assert.equal(pat.used, 800);
  assert.equal(pat.resetAt, Number(inMin(30)) * 1000);

  const app = budget.core('installation:usernode-labs', { now: NOW });
  assert.equal(app.limit, 12500);
  assert.equal(app.remaining, 12400);
  assert.equal(app.used, 100, 'used is derived when GitHub leaves the header out');
  assert.equal(budget.core('installation:Usernode-Labs', { now: NOW }).remaining, 12400, 'owner case does not split a credential');
  assert.equal(budget.core('anonymous', { now: NOW }), null);
});

test('responses without figures, and credentials it does not know, record nothing', () => {
  assert.equal(budget.record('pat', null), null);
  assert.equal(budget.record('pat', {}), null);
  assert.equal(budget.record('pat', { 'x-ratelimit-limit': '5000' }), null);
  assert.equal(budget.record('ghp_secret', headers({ remaining: 1 })), null, 'a token is never a credential name');
  assert.equal(budget.record('installation:../x', headers({ remaining: 1 })), null);
  assert.deepEqual(budget.snapshot({ now: NOW }).credentials, []);
});

test('within one window the lowest remaining wins; a new window replaces; an old one is ignored', () => {
  budget.record('pat', headers({ remaining: 3000 }), { now: NOW });
  budget.record('pat', headers({ remaining: 3100 }), { now: NOW + 1000 });
  assert.equal(budget.core('pat', { now: NOW }).remaining, 3000, 'a late answer from earlier in the hour does not raise it');
  budget.record('pat', headers({ remaining: 2900 }), { now: NOW + 2000 });
  assert.equal(budget.core('pat', { now: NOW }).remaining, 2900);

  budget.record('pat', headers({ remaining: 4990, reset: inMin(90) }), { now: NOW + 3000 });
  assert.equal(budget.core('pat', { now: NOW }).remaining, 4990, 'the next hour starts over');
  budget.record('pat', headers({ remaining: 10, reset: inMin(30) }), { now: NOW + 4000 });
  assert.equal(budget.core('pat', { now: NOW }).remaining, 4990, 'the previous hour cannot come back');
});

test('a window whose reset has passed reads as the whole budget again', () => {
  budget.record('pat', headers({ remaining: 0, reset: inMin(5) }), { now: NOW });
  const later = NOW + 6 * 60 * 1000;
  const c = budget.core('pat', { now: later });
  assert.equal(c.expired, true);
  assert.equal(c.remaining, 5000);
  assert.equal(c.used, 0);
  assert.deepEqual(budget.alertFigures('pat', { now: later }), { used: 0, cap: 5000 });
});

test('the search and graphql budgets are kept apart from core', () => {
  budget.record('pat', headers({ remaining: 4000 }), { now: NOW });
  budget.record('pat', headers({ limit: 30, remaining: 0, resource: 'search' }), { now: NOW });
  assert.equal(budget.core('pat', { now: NOW }).remaining, 4000);
  const rows = budget.snapshot({ now: NOW }).credentials;
  assert.deepEqual(rows.map((r) => r.resource), ['core', 'search'], 'core first');
});

// ─── 2. budgetAllows ────────────────────────────────────────────────────

test('background work is held under 15% left while the reset is ahead, and only background work', (t) => {
  withEnv(t, 'GITHUB_BOT_TOKEN', 'test-token');
  assert.equal(budget.budgetAllows('background', { now: NOW }), true, 'nothing known reads as allowed');

  budget.record('pat', headers({ remaining: 750 }), { now: NOW });
  assert.equal(budget.budgetAllows('background', { now: NOW }), true, '750 is exactly the 15% reserve');

  budget.record('pat', headers({ remaining: 749 }), { now: NOW });
  assert.equal(budget.budgetAllows('background', { now: NOW }), false);
  const hold = budget.backgroundHold({ now: NOW });
  assert.equal(hold.credential, 'pat');
  assert.equal(hold.reserve, 750);
  assert.equal(hold.retryInMs, 30 * 60 * 1000);

  assert.equal(budget.budgetAllows('user', { now: NOW }), true, 'what a person starts is never held');
  assert.equal(budget.budgetAllows('background', { now: NOW + 31 * 60 * 1000 }), true, 'the reset passed');
});

test('a hold logs once per credential per window, not once per caller', (t) => {
  withEnv(t, 'GITHUB_BOT_TOKEN', 'test-token');
  budget.record('pat', headers({ remaining: 100 }), { now: NOW });
  for (let i = 0; i < 40; i += 1) budget.budgetAllows('background', { now: NOW + i });
  const holds = warned.filter((w) => w[0] === 'github-budget');
  assert.equal(holds.length, 1);
  assert.match(holds[0][1], /Holding background GitHub work/);
  assert.deepEqual(
    { credential: holds[0][2].credential, remaining: holds[0][2].remaining, resetInMinutes: holds[0][2].resetInMinutes },
    { credential: 'pat', remaining: 100, resetInMinutes: 30 }
  );
  budget.record('pat', headers({ remaining: 50, reset: inMin(90) }), { now: NOW + 3600 * 1000 });
  budget.budgetAllows('background', { now: NOW + 3600 * 1000 });
  assert.equal(warned.filter((w) => w[0] === 'github-budget').length, 2, 'the next window logs again');
});

test('without a bot token, background work asks the App installation it would use', (t) => {
  withEnv(t, 'GITHUB_BOT_TOKEN', undefined);
  budget.record('pat', headers({ remaining: 0 }), { now: NOW });
  assert.equal(budget.budgetAllows('background', { now: NOW }), true, 'no token: its figures are not what background work spends');
  budget.record('installation:acme', headers({ limit: 12500, remaining: 1000 }), { now: NOW });
  assert.equal(budget.budgetAllows('background', { now: NOW }), false, '1,000 of 12,500 is under 15%');
  assert.equal(budget.budgetAllows('background', { owner: 'other', now: NOW }), true);
  assert.equal(budget.budgetAllows('background', { owner: 'ACME', now: NOW }), false);
});

test('alertFigures: the bot token, and the most-used App installation', () => {
  assert.deepEqual(budget.alertFigures('pat', { now: NOW }), { used: 0, cap: 0 });
  budget.record('pat', headers({ remaining: 900, used: 4100 }), { now: NOW });
  budget.record('installation:a', headers({ limit: 12500, remaining: 12000 }), { now: NOW });
  budget.record('installation:b', headers({ limit: 5000, remaining: 1000 }), { now: NOW });
  assert.deepEqual(budget.alertFigures('pat', { now: NOW }), { used: 4100, cap: 5000 });
  assert.deepEqual(budget.alertFigures('installation', { now: NOW }), { used: 4000, cap: 5000 });
});

// ─── 3. Saying what happened ────────────────────────────────────────────

function rateLimited({
  resetMin = 12, remaining = '0', status = 403, base = NOW,
  message = 'API rate limit exceeded for user ID 276401300.',
} = {}) {
  const err = new Error(message);
  err.status = status;
  const reset = String(Math.floor((base + resetMin * 60 * 1000) / 1000));
  err.response = { status, headers: { 'x-ratelimit-remaining': remaining, 'x-ratelimit-reset': reset } };
  return err;
}

test('a rate-limit refusal is said in plain words, with when it resets', () => {
  assert.equal(budget.rateLimitNotice(rateLimited(), { now: NOW }),
    "GitHub's hourly limit for Homeroom is used up. It resets in about 12 minutes.");
  assert.equal(budget.rateLimitNotice(rateLimited({ resetMin: 0.5 }), { now: NOW }),
    "GitHub's hourly limit for Homeroom is used up. It resets in about a minute.");
  assert.equal(budget.rateLimitNotice(rateLimited({ status: 429 }), { now: NOW }).includes('about 12 minutes'), true);
  assert.equal(budget.rateLimitRetryAfterSeconds(rateLimited(), { now: NOW }), 720);
});

test('an error that lost its headers still reads, from the recorded window or "within the hour"', (t) => {
  withEnv(t, 'GITHUB_BOT_TOKEN', 'test-token');
  const bare = new Error('API rate limit exceeded for user ID 276401300.');
  assert.equal(budget.rateLimitNotice(bare, { now: NOW }),
    "GitHub's hourly limit for Homeroom is used up. It resets within the hour.");
  budget.record('pat', headers({ remaining: 0, reset: inMin(41) }), { now: NOW });
  assert.equal(budget.rateLimitNotice(bare, { now: NOW }),
    "GitHub's hourly limit for Homeroom is used up. It resets in about 41 minutes.");
});

test('other refusals are not called a used-up budget', () => {
  const secondary = rateLimited({ remaining: '17', message: 'You have exceeded a secondary rate limit.' });
  assert.equal(budget.isRateLimitError(secondary), false, 'a per-minute limit is not the hourly one');
  const notFound = Object.assign(new Error('Not Found'), { status: 404 });
  assert.equal(budget.rateLimitNotice(notFound), null);
  assert.equal(budget.rateLimitNotice(null), null);
  assert.deepEqual(budget.githubUnavailableBody(notFound), { error: 'github_unavailable' });
  assert.deepEqual(budget.githubUnavailableBody(rateLimited(), { now: NOW }), {
    error: 'github_unavailable',
    message: "GitHub's hourly limit for Homeroom is used up. It resets in about 12 minutes.",
    retryAfterSeconds: 720,
  });
});

test('the copy carries no em dash', () => {
  const texts = [
    budget.rateLimitNotice(rateLimited(), { now: NOW }),
    budget.rateLimitNotice(new Error('API rate limit exceeded')),
  ];
  for (const text of texts) assert.ok(!/\u2014/.test(text), text);
});

// ─── 4. services/github.js records what it sees ─────────────────────────

function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    const next = answers.shift();
    const empty = next.status === 304 || next.status === 204;
    return new Response(empty ? null : JSON.stringify(next.body === undefined ? {} : next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json', ...next.headers },
    });
  };
  fn.calls = calls;
  return fn;
}

async function octokitWith(fetchImpl) {
  const { Octokit } = await import('@octokit/rest');
  return new Octokit({ auth: 'test-token', request: { fetch: fetchImpl } });
}

test('an instrumented Octokit records success, error and 304 responses, and still throws', async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { name: 'main', commit: { sha: 'a'.repeat(40) } }, headers: { ...headers({ remaining: 4000, reset: liveReset() }), etag: 'W/"one"' } },
    { status: 304, body: '', headers: headers({ remaining: 3999, reset: liveReset() }) },
    { status: 403, body: { message: 'API rate limit exceeded for user ID 1.' }, headers: headers({ remaining: 0, reset: liveReset() }) },
  ]);
  const octokit = github._instrumentForTests(await octokitWith(fetchImpl), 'pat');

  await octokit.rest.repos.getBranch({ owner: 'o', repo: 'r', branch: 'main' });
  assert.equal(budget.core('pat').remaining, 4000);

  await assert.rejects(
    octokit.rest.repos.getBranch({ owner: 'o', repo: 'r', branch: 'main', headers: { 'if-none-match': 'W/"one"' } }),
    (err) => err.status === 304
  );
  assert.equal(budget.core('pat').remaining, 3999, 'a 304 still says where the budget stands');

  await assert.rejects(octokit.rest.repos.get({ owner: 'o', repo: 'r' }), (err) => err.status === 403);
  assert.equal(budget.core('pat').remaining, 0, 'the refusal itself is recorded');
});

test('the installation client is recorded as its own credential', async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: {}, headers: headers({ limit: 12500, remaining: 12499, reset: liveReset() }) }]);
  const octokit = github._instrumentForTests(await octokitWith(fetchImpl), 'installation:Usernode-Labs');
  await octokit.request('GET /repos/{owner}/{repo}', { owner: 'o', repo: 'r' });
  assert.equal(budget.core('installation:usernode-labs').remaining, 12499);
  assert.equal(budget.core('pat'), null);
  // The real wiring: both clients are built through instrument().
  const src = read('src/services/github.js');
  assert.match(src, /return instrument\(await app\.getInstallationOctokit\(id\), `installation:\$\{owner\}`\);/);
  assert.match(src, /return instrument\(new Octokit\(\{ auth: pat \}\), 'pat'\);/);
  assert.match(src, /return instrument\(new Octokit\(\{ auth: token, log: octokitLog \}\), `installation:\$\{owner\}`\);/,
    'and the REST client reads go through (services/github.js getReadOctokit)');
  assert.equal((src.match(/new Octokit\(/g) || []).length, 2,
    'every client github.js builds is one of those two, both recorded');
});

test('a test double without the hook API passes through untouched', () => {
  const fake = { rest: {} };
  assert.equal(github._instrumentForTests(fake, 'pat'), fake);
});

test('the raw fetch reads record against the bot token, or anonymous without one', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  withEnv(t, 'GITHUB_BOT_TOKEN', 'test-token');
  global.fetch = fakeFetch([{ status: 200, body: { number: 7, title: 'x', state: 'open' }, headers: headers({ remaining: 4321, reset: liveReset() }) }]);
  await github.fetchPublicIssue('o', 'budget-a', 7);
  assert.equal(budget.core('pat').remaining, 4321);

  delete process.env.GITHUB_BOT_TOKEN;
  global.fetch = fakeFetch([{ status: 200, body: [], headers: headers({ limit: 60, remaining: 59, reset: liveReset() }) }]);
  await github.fetchIssueComments('o', 'budget-b', 7);
  assert.equal(budget.core('anonymous').remaining, 59);
});

test('checkRepoPublic says the budget is used up instead of passing GitHub\'s words on', async (t) => {
  t.after(() => github._setOctokitFactoryForTests(null));
  github._setOctokitFactoryForTests(() => ({
    rest: { repos: { get: async () => { throw rateLimited({ resetMin: 9, base: Date.now() }); } } },
  }));
  const out = await github.checkRepoPublic('o', 'r');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'rate_limited');
  assert.match(out.message, /^GitHub's hourly limit for Homeroom is used up\. It resets in about (9|10) minutes\.$/);

  github._setOctokitFactoryForTests(() => ({
    rest: { repos: { get: async () => { throw Object.assign(new Error('Server Error'), { status: 502 }); } } },
  }));
  assert.deepEqual(await github.checkRepoPublic('o', 'r'), { ok: false, code: 'github_error', message: 'Server Error' });
});

test('a worker that cannot start for the budget says so in words a person reads', () => {
  const src = read('src/services/worker.js');
  const at = src.indexOf("privacy.code === 'rate_limited'");
  assert.ok(at > 0, 'the bootstrap check handles the rate-limited answer');
  const block = src.slice(at, at + 800);
  assert.match(block, /Homeroom could not start working on \$\{repoOwner\}\/\$\{repoName\}\. \$\{privacy\.message\} Nothing was changed\./);
  assert.match(block, /err\.code = 'github_rate_limited'/);
  assert.ok(src.indexOf("privacy.code === 'rate_limited'") < src.indexOf('Cannot bootstrap worker for'),
    'before the generic "Cannot bootstrap worker" refusal');
});

// ─── 5. Who asks, and the admin read ────────────────────────────────────

test('the timer-driven GitHub callers ask before they spend', () => {
  const asks = /githubBudget\.(budgetAllows\('background'\)|backgroundHold\()|require\('\.\/github-budget'\)\.budgetAllows\('background'\)/;
  for (const rel of [
    'src/services/main-drift-poller.js',
    'src/services/merge-followup-recovery.js',
    'src/services/homeroom-bot.js',
    'src/services/workshop-themes.js',
    'src/services/app-heal.js',
    'src/services/bench/lane.js',
  ]) {
    assert.match(read(rel), asks, `${rel} asks services/github-budget.js`);
  }
  const server = read('server.js');
  const audit = server.slice(server.indexOf('async function auditExistingRepoPrivacy'));
  assert.match(audit.slice(0, audit.indexOf('\n}\n')), /githubBudget\.budgetAllows\('background'\)/, 'the boot privacy audit');
  const headSync = server.slice(server.indexOf('// Pass 6: imported-PR head sync'));
  assert.match(headSync.slice(0, 1800), /if \(!githubBudget\.budgetAllows\('background'\)\) break;/, 'the imported-PR head sync');
  const recover = server.slice(server.indexOf('async function recoverStuckMerges'));
  assert.match(recover.slice(0, recover.indexOf('\n}\n')), /if \(!githubBudget\.budgetAllows\('background'\)\) \{/,
    'the merge recovery sweep (tests/recover-stuck-merges.test.js runs it)');
});

test('the Homeroom bot\'s pass waits for the reset, with the wait as its retry', async (t) => {
  withEnv(t, 'GITHUB_BOT_TOKEN', 'test-token');
  const bot = require('../src/services/homeroom-bot');
  bot._resetForTests();
  const queries = [];
  const pool = {
    async connect() {
      return { async query() { return { rows: [{ acquired: true }] }; }, release() {} };
    },
    async query(sql) {
      queries.push(String(sql));
      if (/SELECT key, value FROM platform_settings/.test(sql)) return { rows: [{ key: bot.KEY_MODE, value: 'shadow' }] };
      return { rows: [] };
    },
  };
  budget.record('pat', headers({ remaining: 20 }), { now: NOW });
  const out = await bot.runOnce(pool, {}, { now: () => NOW, drain: false });
  assert.equal(out.paused, 'github');
  assert.equal(out.retryInMs, 30 * 60 * 1000);
  assert.equal(out.dispatched, undefined, 'nothing was started');
  assert.ok(!queries.some((q) => /homeroom_bot_queue q/.test(q) && /started_at IS NULL/.test(q)), 'no candidates were read');
  bot._resetForTests();
});

test('GET /api/admin/github-budget is an admin-only read of the figures', async (t) => {
  const express = require('express');
  const { adminRoutes } = require('../src/routes/admin');
  let user = { id: 1, username: 'ada', isAdmin: true, canAdminWrite: false };
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(adminRoutes({ jwtSecret: 'test' }));
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/github-budget`;

  budget.record('pat', headers({ remaining: 612, reset: String(Math.floor(Date.now() / 1000) + 23 * 60) }));
  const res = await fetch(url);
  assert.equal(res.status, 200, 'a view-only admin may read it');
  const body = await res.json();
  assert.equal(body.reservePercent, 15);
  assert.equal(body.credentials.length, 1);
  const row = body.credentials[0];
  assert.equal(row.credential, 'pat');
  assert.equal(row.remaining, 612);
  assert.equal(row.held, true, '612 of 5,000 is under the reserve');
  assert.ok(!JSON.stringify(body).includes('test-token'));

  // adminMiddleware: a non-admin is turned away (a redirect off this
  // mount's relative path), never handed the figures.
  user = { id: 2, username: 'bob', isAdmin: false };
  const refused = await fetch(url, { redirect: 'manual' });
  assert.ok([302, 403].includes(refused.status), `refused with ${refused.status}`);
  assert.ok(!(await refused.text()).includes('credentials'));
  user = { id: 1, username: 'ada', isAdmin: true, canAdminWrite: true };
  assert.equal((await fetch(url, { method: 'PUT' })).status, 404, 'there is nothing to write');
});

test('Admin, Limits draws the figures from the AdminUI registry, read-only', () => {
  const src = read('frontend/src/features/admin/admin-limits.tsx');
  const card = src.slice(src.indexOf('function GithubBudgetCard()'), src.indexOf('function LimitsSection()'));
  assert.match(card, /fetchJson\('\/api\/admin\/github-budget'\)/);
  assert.match(card, /id="admin-github-budget" className=\{`\$\{AdminUI\.card\} p-4 mt-4`\}/);
  assert.match(card, /AdminUI\.cardTitle/);
  assert.doesNotMatch(card, /<button|<input|method: 'PUT'/, 'nothing on it writes');
  assert.match(src, /<AppLimitCard canWrite=\{canWrite\} \/>\s*<GithubBudgetCard \/>/);
});

test('a 503 github_unavailable carries the reason, and the CLI prints it', () => {
  const body = budget.githubUnavailableBody(rateLimited({ resetMin: 5 }), { now: NOW });
  const { describeError } = require('../src/cli/agent-command');
  assert.equal(describeError({ status: 503, data: body }),
    "GitHub's hourly limit for Homeroom is used up. It resets in about 5 minutes.");
  assert.equal(describeError({ status: 503, data: { error: 'github_unavailable' } }),
    'GitHub is not reachable from the platform right now.', 'any other outage reads as before');
  for (const rel of ['src/routes/proposal-handoff.js', 'src/routes/cli-agent.js']) {
    const src = read(rel);
    assert.doesNotMatch(src, /json\(\{ error: 'github_unavailable' \}\)/, `${rel} says why when it can`);
    assert.match(src, /json\(githubBudget\.githubUnavailableBody\(err\)\)/);
  }
});
