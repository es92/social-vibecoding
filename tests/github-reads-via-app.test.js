'use strict';

// Everyday GitHub reads go through the GitHub App installation
// (services/github.js getReadOctokit, GITHUB_READS_VIA_APP).
//
// The bot token's 5,000 requests an hour ran out on 2026-10-04 because
// nearly everything spent it. An App installation has a budget of its own,
// so reads of a repository whose owner has an installation go through it;
// writes stay on the bot token, so who authored what on GitHub does not
// change. Pinned here:
//
//   1. The switch: on by default when the App is configured, `off` (and
//      false, 0, no) gives exactly getOctokit.
//   2. The selection rule, against real Octokit clients and fake fetches:
//      reads through the installation; a write sent on the read client
//      still goes out with the bot token; no installation, a refusal (401,
//      403, 404, 429, a used-up budget) or a budget already known to be
//      used up sends the read with the bot token; a 304 or a 5xx does not.
//   3. The raw fetch reads (fetchPublicIssue and friends) follow the same
//      rule.
//   4. No write path moved.
//
// Never calls GitHub.
//
// Run with: node --test tests/github-reads-via-app.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const github = require('../src/services/github');
const budget = require('../src/services/github-budget');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/services/github.js'), 'utf8');

const RESET = () => String(Math.floor(Date.now() / 1000) + 30 * 60);

function rateHeaders(limit, remaining) {
  return {
    'x-ratelimit-limit': String(limit),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': RESET(),
    'x-ratelimit-resource': 'core',
  };
}

// A fake GitHub for one credential: each call is answered by `answer`, and
// remembered with its method, path and Authorization header.
function fakeGithub(name, answer, { limit = 5000 } = {}) {
  const calls = [];
  let remaining = limit;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const call = { name, method: init.method || 'GET', path: u.pathname, auth: init.headers && (init.headers.authorization || init.headers.Authorization) };
    calls.push(call);
    const { status = 200, body = { from: name }, headers = {} } = answer(call) || {};
    remaining = Math.max(0, remaining - 1);
    const empty = status === 304 || status === 204;
    return new Response(empty ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...rateHeaders(limit, remaining), ...headers },
    });
  };
  return { calls, fetchImpl };
}

async function octokitWith(token, fetchImpl) {
  const { Octokit } = await import('@octokit/rest');
  // A silent log: Octokit's request-log plugin reports every 4xx.
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  return new Octokit({ auth: token, request: { fetch: fetchImpl }, log });
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

// The App, its installation on `usernode-bot` and the bot token, as fakes.
function setup(t, { installationAnswer = () => ({}), patAnswer = () => ({}), installed = ['usernode-bot'], appConfigured = true, mode } = {}) {
  withEnv(t, 'GITHUB_BOT_TOKEN', 'bot-token');
  withEnv(t, 'GITHUB_READS_VIA_APP', mode);
  budget._resetForTests();
  const inst = fakeGithub('installation', installationAnswer, { limit: 12500 });
  const pat = fakeGithub('pat', patAnswer);
  const botSentinel = { sentinel: 'getOctokit' };
  github._setReadClientsForTests({
    appConfigured,
    installation: async (owner) => (installed.includes(owner) ? octokitWith('inst-token', inst.fetchImpl) : null),
    installationToken: async (owner) => (installed.includes(owner) ? 'inst-token' : null),
    pat: async () => octokitWith('bot-token', pat.fetchImpl),
  });
  // getOctokit(owner) itself, which the switch falls back to exactly.
  github._setOctokitFactoryForTests(() => botSentinel);
  t.after(() => {
    github._setReadClientsForTests(null);
    github._setOctokitFactoryForTests(null);
    budget._resetForTests();
  });
  return { inst, pat, botSentinel };
}

// ─── 1. The switch ──────────────────────────────────────────────────────

test('on by default when the App is configured; off, false, 0 and no turn it off', (t) => {
  setup(t);
  for (const value of [undefined, '', 'on', 'true', '1', 'yes']) {
    process.env.GITHUB_READS_VIA_APP = value === undefined ? '' : value;
    assert.equal(github.readsViaApp(), true, String(value));
  }
  for (const value of ['off', 'OFF', ' false ', '0', 'no']) {
    process.env.GITHUB_READS_VIA_APP = value;
    assert.equal(github.readsViaApp(), false, value);
  }
});

test('without the App there is nothing to read through', (t) => {
  setup(t, { appConfigured: false });
  assert.equal(github.readsViaApp(), false);
});

test('off is exactly getOctokit, and so is having no bot token', async (t) => {
  const { botSentinel, inst } = setup(t, { mode: 'off' });
  assert.equal(await github.getReadOctokit('usernode-bot'), botSentinel);
  process.env.GITHUB_READS_VIA_APP = '';
  delete process.env.GITHUB_BOT_TOKEN;
  assert.equal(await github.getReadOctokit('usernode-bot'), botSentinel,
    'with no bot token getOctokit already uses the installation');
  assert.equal(inst.calls.length, 0);
});

// ─── 2. The selection rule ──────────────────────────────────────────────

test('a read of a repo whose owner has an installation goes through it', async (t) => {
  const { inst, pat } = setup(t);
  const octokit = await github.getReadOctokit('usernode-bot');
  const { data } = await octokit.rest.git.getRef({ owner: 'usernode-bot', repo: 'demo', ref: 'heads/main' });
  assert.deepEqual(data, { from: 'installation' });
  assert.equal(inst.calls.length, 1);
  assert.equal(inst.calls[0].auth, 'token inst-token');
  assert.equal(pat.calls.length, 0);
  assert.equal(budget.core('installation:usernode-bot').limit, 12500, 'its own budget is recorded');
  assert.equal(budget.core('pat'), null, 'and the bot token spent nothing');
  assert.equal(budget.snapshot().reads.installation, 1);
});

test('an owner with no installation is read with the bot token', async (t) => {
  const { inst, pat } = setup(t);
  const octokit = await github.getReadOctokit('someone-else');
  const { data } = await octokit.rest.repos.get({ owner: 'someone-else', repo: 'fork' });
  assert.deepEqual(data, { from: 'pat' });
  assert.equal(inst.calls.length, 0);
  assert.equal(pat.calls[0].auth, 'token bot-token');
  assert.deepEqual(budget.snapshot().reads.patReasons, { no_installation: 1 });
  assert.deepEqual(budget.snapshot().reads.noInstallation, { 'someone-else': 1 },
    'and names the owner the App would have to be installed on');
});

for (const [label, answer, reason] of [
  ['401', { status: 401, body: { message: 'Bad credentials' } }, 'status_401'],
  ['403 (no permission)', { status: 403, body: { message: 'Resource not accessible by integration' } }, 'status_403'],
  ['404 (cannot see the repository)', { status: 404, body: { message: 'Not Found' } }, 'status_404'],
  ['429', { status: 429, body: { message: 'Too many requests' } }, 'status_429'],
  ['403 with the hourly budget used up', {
    status: 403,
    body: { message: 'API rate limit exceeded for installation ID 1.' },
    headers: { 'x-ratelimit-remaining': '0' },
  }, 'rate_limited'],
]) {
  test(`a ${label} from the installation is sent again with the bot token`, async (t) => {
    const { inst, pat } = setup(t, { installationAnswer: () => answer });
    const octokit = await github.getReadOctokit('usernode-bot');
    const { data } = await octokit.rest.pulls.get({ owner: 'usernode-bot', repo: 'demo', pull_number: 7 });
    assert.deepEqual(data, { from: 'pat' });
    assert.equal(inst.calls.length, 1);
    assert.equal(pat.calls.length, 1);
    assert.equal(pat.calls[0].path, inst.calls[0].path, 'the same request');
    assert.equal(pat.calls[0].auth, 'token bot-token');
    assert.deepEqual(budget.snapshot().reads.patReasons, { [reason]: 1 });
  });
}

test('a 304 is an answer, and a 5xx is GitHub failing: neither is sent again', async (t) => {
  for (const status of [304, 502]) {
    const { inst, pat } = setup(t, { installationAnswer: () => ({ status, body: { message: 'x' } }) });
    const octokit = await github.getReadOctokit('usernode-bot');
    await assert.rejects(
      octokit.rest.repos.getBranch({ owner: 'usernode-bot', repo: 'demo', branch: 'main', headers: { 'if-none-match': 'W/"e"' } }),
      (err) => err.status === status
    );
    assert.equal(inst.calls.length, 1);
    assert.equal(pat.calls.length, 0, `${status}: the bot token is not spent`);
  }
});

test('a budget already known to be used up goes straight to the bot token', async (t) => {
  const { inst, pat } = setup(t);
  budget.record('installation:usernode-bot', rateHeaders(12500, 0));
  const octokit = await github.getReadOctokit('usernode-bot');
  const { data } = await octokit.rest.repos.getContent({ owner: 'usernode-bot', repo: 'demo', path: 'dapp.json' });
  assert.deepEqual(data, { from: 'pat' });
  assert.equal(inst.calls.length, 0, 'no request is wasted on a refusal');
  assert.deepEqual(budget.snapshot().reads.patReasons, { budget_used_up: 1 });
});

test('a write sent on the read client still goes out with the bot token', async (t) => {
  const { inst, pat } = setup(t);
  const octokit = await github.getReadOctokit('usernode-bot');
  await octokit.rest.issues.createComment({ owner: 'usernode-bot', repo: 'demo', issue_number: 3, body: 'hi' });
  await octokit.request('PATCH /repos/{owner}/{repo}/git/refs/{+ref}', { owner: 'usernode-bot', repo: 'demo', ref: 'heads/x', sha: 'a'.repeat(40) });
  assert.equal(inst.calls.length, 0, 'the installation never writes');
  assert.deepEqual(pat.calls.map((c) => [c.method, c.auth]), [['POST', 'token bot-token'], ['PATCH', 'token bot-token']]);
  assert.equal(pat.calls[1].path, '/repos/usernode-bot/demo/git/refs/heads/x', 'the {+ref} path survives the hand-over');
});

test('the read functions in github.js go through it: getBranchSha, getPR, checkRepoPublic', async (t) => {
  const { inst, pat } = setup(t, {
    installationAnswer: (call) => {
      if (call.path.endsWith('/git/ref/heads/feature/x')) return { body: { object: { sha: 'b'.repeat(40) } } };
      if (call.path.endsWith('/pulls/9')) return { body: { number: 9, merged: false } };
      return { body: { private: false } };
    },
  });
  assert.equal(await github.getBranchSha('usernode-bot', 'demo', 'feature/x'), 'b'.repeat(40));
  assert.equal((await github.getPR('usernode-bot', 'demo', 9)).number, 9);
  assert.deepEqual(await github.checkRepoPublic('usernode-bot', 'demo'), { ok: true, private: false });
  assert.equal(inst.calls.length, 3);
  assert.equal(pat.calls.length, 0);
});

test('checkRepoPublic asks the bot token when the installation cannot see a repo', async (t) => {
  const { pat } = setup(t, {
    installationAnswer: () => ({ status: 404, body: { message: 'Not Found' } }),
    patAnswer: () => ({ body: { private: true } }),
  });
  assert.deepEqual(await github.checkRepoPublic('usernode-bot', 'gone-private'), { ok: true, private: true });
  assert.equal(pat.calls.length, 1);
});

// ─── 3. The raw fetch reads ─────────────────────────────────────────────

function stubFetch(t, answer) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const auth = init.headers && init.headers.Authorization;
    calls.push({ url: String(url), auth });
    const { status = 200, body = { number: 4, title: 't', state: 'open' } } = answer({ url: String(url), auth }) || {};
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...rateHeaders(auth === 'Bearer inst-token' ? 12500 : 5000, 100) },
    });
  };
  t.after(() => { global.fetch = real; });
  return calls;
}

test('fetchPublicIssue reads through the installation, and falls back on a refusal', async (t) => {
  setup(t);
  const calls = stubFetch(t, ({ auth, url }) => (auth === 'Bearer inst-token' && url.endsWith('/issues/5')
    ? { status: 404, body: { message: 'Not Found' } }
    : {}));
  const four = await github.fetchPublicIssue('usernode-bot', 'reads-a', 4);
  assert.equal(four.issue.number, 4);
  assert.deepEqual(calls.map((c) => c.auth), ['Bearer inst-token']);
  assert.equal(budget.core('installation:usernode-bot').limit, 12500);

  calls.length = 0;
  await github.fetchPublicIssue('usernode-bot', 'reads-a', 5);
  assert.deepEqual(calls.map((c) => c.auth), ['Bearer inst-token', 'Bearer bot-token'],
    'a 404 from the installation is asked again with the bot token');
});

test('switched off, the raw reads use the bot token exactly as before', async (t) => {
  setup(t, { mode: 'off' });
  const calls = stubFetch(t, () => ({}));
  await github.fetchPublicIssue('usernode-bot', 'reads-b', 4);
  await github.fetchIssueComments('usernode-bot', 'reads-b', 4);
  assert.deepEqual(calls.map((c) => c.auth), ['Bearer bot-token', 'Bearer bot-token']);
  assert.deepEqual(budget.snapshot().reads, { installation: 0, pat: 0, patReasons: {}, noInstallation: {} }, 'nothing is routed');
});

// ─── 4. No write path moved ─────────────────────────────────────────────

function body(name) {
  const at = SRC.indexOf(`async function ${name}(`);
  assert.ok(at >= 0, name);
  const end = SRC.indexOf('\n}\n', at);
  return SRC.slice(at, end);
}

test('every write keeps the bot token; only standalone reads moved', () => {
  const writes = [
    'pushFiles', 'createRootCommit', 'createBranch', 'ensureBranchAtSha', 'advanceBranchToSha',
    'forceBranchToSha', 'createProposalCommit', 'createPR', 'updatePR', 'closePR', 'reopenPR',
    'mergePR', 'deleteBenchBranch', 'updateIssueTitle', 'updateIssueBody', 'closeIssue',
    'createIssue', 'createIssueComment', 'createRepo',
  ];
  for (const name of writes) {
    assert.doesNotMatch(body(name), /getReadOctokit|installationReadOctokit|publicReadFetch/, `${name} must not move`);
  }
  // The draft flip reads with getReadOctokit (through getPR) but writes with getOctokit.
  assert.match(body('markPrReadyForReview'), /const octokit = await getOctokit\(owner\);\n\s+const result = await octokit\.graphql\(/);
  // The bot-identity reads stay on the bot token: what it may push, and its
  // own invitations.
  assert.match(body('verifyBotAccess'), /botPatOctokit\(\)/);
  assert.match(body('acceptInvitationFor'), /botPatOctokit\(\)/);

  const reads = [
    'getFileContent', 'compareCommitAncestry', 'getCommitParents', 'getCommitTree', 'getBranchSha',
    'getRepoHead', 'getCommitAt', 'findOpenPrByBranch', 'listOpenPulls', 'getPR', 'listChangedFiles',
    'compareRefs', 'getProposalDiff', 'compareFiles', 'getIssue', 'checkRepoPublic',
    'compareCommitSubjects',
  ];
  for (const name of reads) {
    assert.match(body(name), /await getReadOctokit\(owner\)/, `${name} reads through getReadOctokit`);
    assert.doesNotMatch(body(name), /\.(create|update|merge|delete)\w*\(/, `${name} writes nothing`);
  }
});

test('the switch is documented where the other GitHub variables are', () => {
  const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(env, /^# GITHUB_READS_VIA_APP=/m);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dapp.json'), 'utf8'));
  const entry = manifest.platform_env.find((e) => e.key === 'GITHUB_READS_VIA_APP');
  assert.ok(entry, 'listed in the Platform variables panel');
  assert.match(entry.description, /\boff\b/);
});
