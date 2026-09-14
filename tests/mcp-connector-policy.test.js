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
    // #1225 — saying somebody is working on a request, and handing it back.
    // A local CLI session has reached both through the denylist since claims
    // existed; a connector session could not, so the same agent was visible
    // on the board from a checkout and invisible from a chat.
    ['POST', '/api/apps/recipe-box/github-issues/12/claim'],
    ['DELETE', '/api/apps/recipe-box/github-issues/12/claim'],
    ['GET', '/api/apps/recipe-box/promoted'],
    ['GET', '/api/apps/recipe-box/messages'],
    ['POST', '/api/apps/recipe-box/messages'],
    ['POST', '/api/apps/recipe-box/issues'],
    ['GET', '/api/sessions/412'],
    ['GET', '/api/sessions/412/status'],
    ['GET', '/api/sessions/412/spec'],
    // #2028 — metadata-only deltas on the caller's own proposal. The route
    // (not this matcher) enforces ownership and the 50-issue cap.
    ['PATCH', '/api/sessions/412/linked-issues'],
    ['GET', '/api/me/active-sessions'],
    // #967 pass 2 — the proposal pipeline. Each of these is owner-scoped or
    // access-checked by its own handler; the allowlist only decides whether
    // a connector token may knock on the door at all.
    ['GET', '/api/apps/recipe-box/pr-import/preview'],
    ['POST', '/api/apps/recipe-box/pr-import'],
    // #1054 — advancing a proposal that is already up for a vote, from a
    // branch in its author's own fork. On the list because the agent that
    // wrote the code lives behind the connector, and a failing check gates
    // merge; the route refuses anything that is not the caller's own open
    // proposal.
    ['POST', '/api/apps/recipe-box/proposals/412/update-from-fork'],
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
    ['GET', '/api/sessions/412/linked-issues'],
    ['POST', '/api/sessions/412/linked-issues'],
    ['PATCH', '/api/sessions/412/linked-issues/extra'],
    ['PATCH', '/api/sessions//linked-issues'],
    ['GET', '/api/apps/recipe-box/pr-import'],
    ['POST', '/api/apps/recipe-box/pr-import/preview'],
    // Reading an issue's comments does not imply writing one, and the
    // allowlisted pattern is exactly one level deep.
    ['POST', '/api/apps/recipe-box/github-issues/12/comments'],
    ['GET', '/api/apps/recipe-box/github-issues/12/comments/3'],
    ['GET', '/api/apps/recipe-box/github-issues//comments'],
    // A claim is one exact shape too. Reading the board is a different
    // route, and nothing else under an issue becomes reachable with it.
    ['GET', '/api/apps/recipe-box/github-issues/12/claim'],
    ['POST', '/api/apps/recipe-box/github-issues//claim'],
    ['POST', '/api/apps/recipe-box/github-issues/12/claim/extra'],
    ['POST', '/api/apps/recipe-box/github-issues/12/bounty'],
    // Path-shape games.
    ['GET', '/api/apps/recipe-box/github-issues/12'],
    ['GET', '/api/apps'.concat('/')],
    ['GET', '/api/sessions'],
    ['GET', '/api/sessions/412/status/extra'],
    ['POST', '/api/apps/recipe-box/issues/12/headless-session/extra'],
    ['POST', '/api/apps/recipe-box/issues//headless-session'],
    // The update route is one exact shape. Nothing else under /proposals/ is
    // reachable, and the update itself is a POST only.
    ['GET', '/api/apps/recipe-box/proposals/412/update-from-fork'],
    ['POST', '/api/apps/recipe-box/proposals/412'],
    ['POST', '/api/apps/recipe-box/proposals'],
    ['POST', '/api/apps/recipe-box/proposals//update-from-fork'],
    ['POST', '/api/apps/recipe-box/proposals/412/update-from-fork/extra'],
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
    // concrete segment so the pattern matcher sees a real path. The query
    // string is dropped for the same reason the middleware never sees one:
    // routes/cli-auth.js matches on `req.path`, which express has already
    // stripped it from (#1196 added `?include_imported=1` to one call).
    const target = rawPath.replace(/\$\{[^}]*\}/g, 'x').split('?')[0];
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

test('resume is on the list only because the route is owner-scoped', () => {
  // Same reasoning again: submit_work's `propose: true` reopens a paused
  // session before promoting it (an external update usually lands on one).
  // What makes the entry safe is the handler — its ownership probe answers
  // before any platform-wide bookkeeping runs, and the resuming UPDATE
  // itself matches (id, user_id, 'paused'). If either loosens, this entry
  // has to come back off.
  const SESSIONS_SRC = fs.readFileSync(
    path.join(__dirname, '../src/routes/sessions.js'), 'utf8'
  );
  const handler = SESSIONS_SRC.slice(
    SESSIONS_SRC.indexOf("router.post('/api/sessions/:id/resume'")
  );
  assert.ok(handler.length > 0, 'the resume handler exists');
  assert.match(
    handler.slice(0, 1200),
    /WHERE id = \$1 AND user_id = \$2/,
    'the ownership probe answers first'
  );
  assert.match(
    handler.slice(0, 4200),
    /WHERE id = \$1 AND user_id = \$2 AND status = 'paused'/,
    'the resuming UPDATE is owner-scoped too'
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

// ── #1054: updating a proposal already up for a vote ───────────────────

test('the update route is on the list only because it refuses anything but the caller’s own proposal', () => {
  // Same reasoning as promote above: the allowlist decides whether a
  // connector token may knock, and what makes THIS door safe is the pair of
  // gates behind it. The route loads the proposal by (id, app_id) and the
  // service refuses it unless the row's user_id is the caller's — twice, the
  // second time under the lock against a freshly re-read row.
  const HANDOFF_SRC = fs.readFileSync(
    path.join(__dirname, '../src/routes/proposal-handoff.js'), 'utf8'
  );
  const handler = HANDOFF_SRC.slice(
    HANDOFF_SRC.indexOf("router.post('/api/apps/:slug/proposals/:id/update-from-fork'")
  ).slice(0, 3000);
  assert.match(handler, /getAppForUser\(pool, req\.params\.slug, req\.user, 'collab'/,
    'the app is access-checked at the same bar the browser\'s proposal paths use');
  assert.match(handler, /WHERE cs\.id = \$1 AND cs\.app_id = \$2/,
    'the handler loads the proposal on the named app, not any proposal by id');
  const UPDATE_SRC = fs.readFileSync(
    path.join(__dirname, '../src/services/proposal-update.js'), 'utf8'
  );
  assert.match(UPDATE_SRC, /Number\(session\.user_id\) !== Number\(user\.id\)/,
    'and the service refuses a proposal that is not the caller\'s');
  assert.equal((UPDATE_SRC.match(/ownershipGate\(/g) || []).length, 3,
    'defined once, applied twice — before the queue and again under the lock');
  // Nothing on this path votes, merges or withdraws. Checked against the CODE
  // with its prose stripped: the predicate that decides what a push may land
  // on names the archived status in a comment to say a push must NOT reopen
  // one (#1071), and reading that as a write would be exactly backwards.
  const code = UPDATE_SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  assert.doesNotMatch(code, /admin-merge|INSERT INTO pr_votes|archive/);
});

test('the connector cannot reach GitHub except through the app’s own repo plumbing', () => {
  // mcp-tools talks only to the platform over loopback. The one module that
  // holds a user's GitHub token is external-agent-tasks, and it is reached
  // through that module, never inlined into a tool.
  assert.doesNotMatch(TOOLS_SRC, /api\.github\.com/);
  assert.doesNotMatch(TOOLS_SRC, /github_oauth_token/);
  assert.match(TOOLS_SRC, /require\('\.\/external-agent-tasks'\)/);
});

// ── #1219 follow-up: the setup hint's own writes and reads ─────────────
//
// Arming the in-band setup tip is the first thing on this transport that
// WRITES a row from the request body rather than from an authenticated
// identity alone. Two properties keep that safe, and both are positional —
// they are true because of where the code sits, so a refactor that moves it
// breaks them without changing a single expression.

test('the hint is armed only after the caller is authenticated and audited', () => {
  const REMOTE_SRC = fs.readFileSync(
    path.join(__dirname, '../src/routes/mcp-remote.js'), 'utf8'
  );
  const authAt = REMOTE_SRC.indexOf('auth = await authenticateConnector(pool, bearer.token)');
  const auditAt = REMOTE_SRC.indexOf("eventType: 'token_used'");
  const armAt = REMOTE_SRC.indexOf('isInitializeRequest(req.body)');
  const dispatchAt = REMOTE_SRC.indexOf('mcpTools.registerTools(server');
  assert.ok(authAt > 0 && auditAt > 0 && armAt > 0 && dispatchAt > 0);
  // An unauthenticated body must never reach a write. `armHint` takes the
  // grant id and the user id off `auth`, so this is not merely tidy: before
  // that point there is no grant to key the row on, and an anonymous POST
  // could otherwise insert one row per made-up value.
  assert.ok(armAt > authAt, 'the arm is after authentication');
  // And after the audit insert, so the log records the call in the order it
  // happened even when the arm is the thing that fails.
  assert.ok(armAt > auditAt, 'the arm is after the token_used audit row');
  assert.ok(armAt < dispatchAt, 'the arm precedes tool dispatch, so a read in the same request can claim it');
  // Fire-and-forget: an advisory tip must not be able to fail a tools/call.
  const armBlock = REMOTE_SRC.slice(armAt, dispatchAt);
  assert.match(armBlock, /\.armHint\(/);
  assert.match(armBlock, /\.catch\(/, 'a rejected arm is swallowed, not surfaced');
  assert.doesNotMatch(armBlock, /await\s+require\('\.\.\/services\/mcp-hint-throttle'\)/,
    'the request does not wait on the arm');
});

test('the tip’s throttle state is readable by the browser, never by the connector', () => {
  // The status line rides on GET /api/me/connectors, which is cookie-
  // authenticated. That route is deliberately NOT on the connector
  // allowlist, so the thing being throttled cannot read — or infer — its own
  // remaining budget, and a model cannot be talked into checking whether it
  // has a slot left before deciding what to say.
  for (const method of ['GET', 'POST', 'DELETE']) {
    assert.equal(
      policy.isConnectorApiRequest(method, '/api/me/connectors'), false,
      `${method} /api/me/connectors is off the connector allowlist`
    );
  }
  assert.equal(policy.isConnectorApiRequest('DELETE', '/api/me/connectors/g_1'), false);

  const REMOTE_SRC = fs.readFileSync(
    path.join(__dirname, '../src/routes/mcp-remote.js'), 'utf8'
  );
  const handler = REMOTE_SRC.slice(
    REMOTE_SRC.indexOf("router.get('/api/me/connectors'")
  ).slice(0, 4000);
  assert.match(handler, /if \(!req\.user\) return res\.status\(401\)/,
    'the cookie half refuses an unauthenticated caller');
  assert.match(handler, /getHintStatus\(pool, \{ userId: req\.user\.id \}\)/,
    'and reads the status for the signed-in user only');
  // Read-only in both directions: this router exposes no write path for the
  // throttle. A "show it again" control is a control for making the
  // connector nag, so there is deliberately none to route to.
  assert.doesNotMatch(REMOTE_SRC, /resetHint|clearHint|hint\/reset/);
});
