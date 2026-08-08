// Hosted MCP connector — what a connector token may reach.
//
// The CLI's `api:access` is a DENYLIST: everything under /api/ except a
// handful of prefixes. That is the right shape for a credential a developer
// holds in a checkout they control. It is the wrong shape for a token held
// on the user's behalf by a third-party chat product, because every new
// platform endpoint would silently widen it.
//
// So connector tokens get an exhaustive ALLOWLIST, and this file is the
// proof that it is exhaustive and fail-closed: a route that nobody thought
// about is refused, not permitted.
//
// Run with: node --test tests/mcp-connector-policy.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const policy = require('../src/services/cli-api-policy');

const CLI_AUTH_SRC = fs.readFileSync(
  path.join(__dirname, '../src/routes/cli-auth.js'), 'utf8'
);
const ISSUES_SRC = fs.readFileSync(
  path.join(__dirname, '../src/routes/issues.js'), 'utf8'
);
const TOOLS_SRC = fs.readFileSync(
  path.join(__dirname, '../src/services/mcp-tools.js'), 'utf8'
);
const VOTES_SRC = fs.readFileSync(
  path.join(__dirname, '../src/routes/votes.js'), 'utf8'
);

test('the allowlist permits exactly the routes the tools need', () => {
  const allowed = [
    ['GET', '/api/apps'],
    ['GET', '/api/apps/recipe-box'],
    ['GET', '/api/apps/recipe-box/github-issues'],
    // A request's GitHub comments — the half of its discussion that does not
    // live in the platform's own thread. prepare_work reads it so the work
    // order carries the requirements raised in the replies.
    ['GET', '/api/apps/recipe-box/github-issues/12/comments'],
    ['GET', '/api/apps/recipe-box/promoted'],
    ['GET', '/api/apps/recipe-box/messages'],
    ['POST', '/api/apps/recipe-box/messages'],
    ['POST', '/api/apps/recipe-box/issues'],
    ['GET', '/api/sessions/412'],
    ['GET', '/api/sessions/412/status'],
    ['GET', '/api/sessions/412/spec'],
    ['GET', '/api/me/active-sessions'],
    // #967 pass 2 — the proposal pipeline. Each of these is owner-scoped or
    // access-checked by its own handler; the allowlist only decides whether
    // a connector token may knock on the door at all.
    ['GET', '/api/apps/recipe-box/pr-import/preview'],
    ['POST', '/api/apps/recipe-box/pr-import'],
    ['POST', '/api/apps/recipe-box/issues/12/headless-session'],
    ['POST', '/api/sessions/412/clone-headless'],
    ['POST', '/api/sessions/412/promote'],
  ];
  for (const [method, target] of allowed) {
    assert.equal(
      policy.isConnectorApiRequest(method, target), true,
      `${method} ${target} is allowed`
    );
  }
});

test('fail-closed: anything not listed is refused', () => {
  // A representative sweep of the platform's real surface. None of these
  // are on the connector allowlist, and none may become reachable by
  // accident.
  const refused = [
    ['GET', '/api/admin/users'],
    ['POST', '/api/admin/merge'],
    ['GET', '/api/cli/token/status'],
    ['DELETE', '/api/cli/token/current'],
    ['GET', '/api/me/cli-tokens'],
    ['DELETE', '/api/me/cli-tokens/7'],
    ['GET', '/api/debug/state'],
    ['GET', '/api/internal/whatever'],
    ['POST', '/api/iframe-token'],
    ['GET', '/api/node-status'],
    ['GET', '/api/v4/anything'],
    ['GET', '/api/apps/recipe-box/secrets'],
    ['POST', '/api/apps/recipe-box/secrets'],
    ['GET', '/api/me/llm-grants'],
    ['POST', '/api/auth/password'],
    // Voting, merging and withdrawal stay off the list. A connector may put
    // the caller's own work up for a vote; it may never cast one, settle
    // one, or take somebody's proposal down.
    ['POST', '/api/sessions/412/vote'],
    ['POST', '/api/sessions/412/admin-merge'],
    ['POST', '/api/sessions/412/archive'],
    ['POST', '/api/sessions/412/chat'],
    ['DELETE', '/api/apps/recipe-box'],
    // Right path, wrong method.
    ['DELETE', '/api/apps/recipe-box/issues'],
    ['POST', '/api/apps'],
    ['POST', '/api/sessions/412'],
    ['GET', '/api/apps/recipe-box/pr-import'],
    ['POST', '/api/apps/recipe-box/pr-import/preview'],
    // Reading an issue's comments does not imply writing one, and the
    // allowlisted pattern is exactly one level deep.
    ['POST', '/api/apps/recipe-box/github-issues/12/comments'],
    ['GET', '/api/apps/recipe-box/github-issues/12/comments/3'],
    ['GET', '/api/apps/recipe-box/github-issues//comments'],
    // Path-shape games.
    ['GET', '/api/apps/recipe-box/github-issues/12'],
    ['GET', '/api/apps'.concat('/')],
    ['GET', '/api/sessions'],
    ['GET', '/api/sessions/412/status/extra'],
    ['POST', '/api/apps/recipe-box/issues/12/headless-session/extra'],
    ['POST', '/api/apps/recipe-box/issues//headless-session'],
  ];
  for (const [method, target] of refused) {
    assert.equal(
      policy.isConnectorApiRequest(method, target), false,
      `${method} ${target} is refused`
    );
  }
});

test('the shared canonical-target wall still applies underneath', () => {
  // The allowlist is checked AFTER canonicalApiTarget, so traversal,
  // encoding tricks and control characters never reach the matcher.
  for (const target of [
    '/api/apps/../admin/users',
    '//api/apps',
    '/api/apps%2F..%2Fadmin',
    '/api/apps\u0000',
    'https://evil.example/api/apps',
    'api/apps',
    '',
  ]) {
    assert.equal(
      policy.isConnectorApiRequest('GET', target), false,
      `${JSON.stringify(target)} is refused`
    );
  }
  // Denied prefixes/segments are refused even when a pattern would match.
  assert.equal(policy.isConnectorApiRequest('GET', '/api/apps/recipe-box/api-key'), false);
});

test('a query string does not change the decision', () => {
  // Route matching is on the path; Express hands `req.path` in, so a query
  // must neither enable nor disable a route.
  assert.equal(policy.isConnectorApiRequest('GET', '/api/apps'), true);
  assert.equal(policy.isConnectorApiRequest('GET', '/api/apps?demo=1'), false,
    'a full target with a query is not a path and is refused');
});

test('the method comparison is case-insensitive but exact', () => {
  assert.equal(policy.isConnectorApiRequest('get', '/api/apps'), true);
  assert.equal(policy.isConnectorApiRequest('GET', '/api/apps'), true);
  assert.equal(policy.isConnectorApiRequest('PATCH', '/api/apps'), false);
  assert.equal(policy.isConnectorApiRequest(null, '/api/apps'), false);
  assert.equal(policy.isConnectorApiRequest('GET', null), false);
});

test('connector tokens route to the allowlist, never to the CLI denylist', () => {
  // The entry point must pick the chain from the token's SHAPE, and the
  // connector chain must consult isConnectorApiRequest.
  assert.match(CLI_AUTH_SRC, /function looksLikeConnectorBearer/);
  assert.match(CLI_AUTH_SRC, /\/\^Bearer svmcp_\/i/);
  assert.match(
    CLI_AUTH_SRC,
    /looksLikeConnectorBearer\(req\) \? connectorChain : chain/,
    'the chain is selected by token shape'
  );
  assert.match(
    CLI_AUTH_SRC,
    /if \(!isConnectorApiRequest\(req\.method, req\.path\)\)[\s\S]{0,120}insufficient_scope/,
    'the connector chain refuses anything off the allowlist'
  );
});

test('a connector inherits the automated-caller guards', () => {
  // req.cliAuthenticated means "not a browser", which is exactly true of a
  // connector — so the existing refusals keyed on it must keep binding.
  assert.match(CLI_AUTH_SRC, /req\.cliAuthenticated = true;[\s\S]{0,300}req\.connectorClientId/);
  // The load-bearing one: governance proposals carrying a secret value.
  assert.match(
    ISSUES_SRC,
    /req\.cliAuthenticated && kind === 'secret_change'[\s\S]{0,160}403/,
    'credential management stays refused for automated callers'
  );
});

test('writes need the write scope; reads need only the read scope', () => {
  assert.match(
    CLI_AUTH_SRC,
    /const needsWrite = req\.method !== 'GET';/,
    'the write scope is required for every mutation'
  );
  assert.match(CLI_AUTH_SRC, /needsWrite && !auth\.scopes\.includes\(CONNECTOR_WRITE_SCOPE\)/);
  assert.match(CLI_AUTH_SRC, /!needsWrite && !auth\.scopes\.includes\(CONNECTOR_READ_SCOPE\)/);
});

test('create_request can only ever file an ordinary request', () => {
  // The issues route multiplexes ordinary requests and governance
  // proposals; the tool must pin the kind rather than pass one through.
  assert.match(TOOLS_SRC, /kind: 'general'/);
  assert.doesNotMatch(TOOLS_SRC, /kind:\s*(?:kind|args\.kind|input\.kind)/,
    'kind is never taken from tool input');
});

test('every route the tools call is on the allowlist', () => {
  // The two lists are maintained separately, so drift between them would
  // show up as a tool that 403s in production. Extract the literal paths
  // the tool module calls and check each one.
  const calls = [...TOOLS_SRC.matchAll(/callPlatform\(\s*baseUrl,\s*accessToken,\s*'([A-Z]+)',\s*[`']([^`']*)[`']/g)];
  assert.ok(calls.length >= 6, 'found the tool call sites');
  for (const [, method, rawPath] of calls) {
    // Template literals interpolate the slug / proposal id; substitute a
    // concrete segment so the pattern matcher sees a real path.
    const target = rawPath.replace(/\$\{[^}]*\}/g, 'x');
    assert.equal(
      policy.isConnectorApiRequest(method, target), true,
      `${method} ${target} (called by a tool) is on the allowlist`
    );
  }
});

// ── #967 pass 2: the write half ────────────────────────────────────────

test('promote is on the list only because the route is owner-scoped', () => {
  // A connector may put the CALLER'S OWN finished build up for a vote. The
  // reason that is safe is not the allowlist — it is that the handler loads
  // the session by (id, user_id) and refuses anything else with a 404. If
  // that WHERE clause ever loosens, this entry has to come back off.
  assert.match(
    VOTES_SRC,
    /router\.post\('\/api\/sessions\/:id\/promote'[\s\S]{0,600}WHERE cs\.id = \$1 AND cs\.user_id = \$2/,
    'the promote handler is scoped to the calling user'
  );
});

test('the promoted-session cap the import route lacks is applied by the connector', () => {
  // POST /api/apps/:slug/pr-import predates this and does not enforce the
  // promoted-session cap — importing used to be a one-at-a-time human
  // action. submit_work reaches it from a loop a model can run, so the cap
  // is reproduced with the SAME bound and the same wording as the promote
  // path, and applied before the pull request is opened.
  const limits = require('../src/services/connector-limits');
  assert.equal(typeof limits.checkPromotedCap, 'function');
  const LIMITS_SRC = fs.readFileSync(
    path.join(__dirname, '../src/services/connector-limits.js'), 'utf8'
  );
  const wording = /You already have \$\{caps\.promotedSessions\} PRs up for vote\./;
  assert.match(LIMITS_SRC, wording, 'the connector says what the browser says');
  assert.match(VOTES_SRC, /You already have \$\{caps\.promotedSessions\} PRs up for vote/);
  // Both count the same rows: promoted + merging, headless excluded.
  assert.match(
    LIMITS_SRC,
    /status IN \('promoted', 'merging'\) AND is_headless = FALSE/
  );
  // A limiter that cannot run refuses rather than waving the write through.
  assert.match(LIMITS_SRC, /if \(count === null\) return UNAVAILABLE;/);
});

test('the connector cannot reach GitHub except through the app’s own repo plumbing', () => {
  // mcp-tools talks only to the platform over loopback. The one module that
  // holds a user's GitHub token is external-agent-tasks, and it is reached
  // through that module, never inlined into a tool.
  assert.doesNotMatch(TOOLS_SRC, /api\.github\.com/);
  assert.doesNotMatch(TOOLS_SRC, /github_oauth_token/);
  assert.match(TOOLS_SRC, /require\('\.\/external-agent-tasks'\)/);
});
