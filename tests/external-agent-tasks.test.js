// Hosted MCP connector — handing work to the user's own coding agent.
//
// This service is the only place a proposal can be created without a human
// clicking anything, and it used to be the only place the platform used a
// USER'S GitHub token. It no longer holds one at all: the fork and the
// branch are made by the user's own coding agent, and everything this file
// reads about them is public. The tests below are weighted accordingly:
//
//   1. NO user credential is used anywhere. The GitHub link is identity-only
//      now (services/github-link), so a re-introduced `authorization: Bearer
//      <user token>` header would silently re-widen the OAuth scope this
//      whole design exists to avoid.
//   2. The attribution gate. A proposal opened this way carries the
//      caller's name and their agent's badge, so the pull request's head
//      must live in a repository owned by the login THEY verified. This is
//      checked on every path — created, adopted, and named-by-number — and
//      it must refuse before the platform is asked to import anything. Only
//      the OWNER is checked: the fork's name is the agent's choice.
//   3. The caps are applied BEFORE a pull request is opened, so a refusal
//      never leaves a stray PR on someone's app.
//   4. The work order is complete — it now has to create the fork and the
//      branch too — carries no credential, and the user-written brief inside
//      it stays marked as data.
//   5. source stays 'imported'. The connector adds an author, not a new
//      kind of proposal.
//
// Run with: node --test tests/external-agent-tasks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const svc = require('../src/services/external-agent-tasks');

const SRC = fs.readFileSync(
  path.join(__dirname, '../src/services/external-agent-tasks.js'), 'utf8'
);

// ── Fakes ──────────────────────────────────────────────────────────────

// A fetch stub for the service's PUBLIC GitHub reads. `routes` maps
// "METHOD /path" to a response; anything unmatched is a hard failure so a
// test can never pass by accidentally hitting a real network path.
function fakeFetch(routes, calls) {
  return async (url, init) => {
    const method = (init && init.method) || 'GET';
    const pathname = String(url).replace('https://api.github.com', '');
    const key = `${method} ${pathname}`;
    calls.push({ key, body: init && init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const hit = routes[key];
    if (!hit) throw new Error(`unstubbed GitHub call: ${key}`);
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      text: async () => (hit.body === undefined ? '' : JSON.stringify(hit.body)),
    };
  };
}

function withFetch(routes, calls, fn) {
  const original = global.fetch;
  global.fetch = fakeFetch(routes, calls);
  return Promise.resolve(fn()).finally(() => { global.fetch = original; });
}

// A pool that dispatches on a substring of the SQL, so a test states what
// it expects to be asked rather than the order it is asked in.
function fakePool(handlers, queries) {
  return {
    async query(sql, params) {
      queries.push({ sql, params });
      for (const [needle, rows] of handlers) {
        if (sql.includes(needle)) {
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      throw new Error(`unstubbed query: ${sql.slice(0, 80)}`);
    },
  };
}

const okLimits = {
  checkPrepareRate: async () => null,
  checkPromotedCap: async () => null,
  checkProposalRate: async () => null,
};

const APP = {
  id: 7, slug: 'recipe-box', name: 'Recipe Box',
  repo_url: 'https://github.com/usernode-bot/recipe-box',
};

// A real-shaped base commit: 40 hex characters. prepareWork now refuses
// anything else outright, so the fixture has to be the real thing — which
// is also what lets the work-order assertions below pin the exact
// `git checkout -b <branch> <40 hex>` line the connector must emit.
const BASE_SHA = `ba5e${'0'.repeat(34)}fe`;

function baseGh(overrides = {}) {
  return {
    isEnabled: () => true,
    parseGithubUrl: (url) => {
      const m = /github\.com\/([^/]+)\/([^/.]+)/.exec(String(url || ''));
      return m ? { owner: m[1], repo: m[2] } : null;
    },
    getBranchSha: async () => BASE_SHA,
    ...overrides,
  };
}

// A deployment that HAS a GitHub OAuth app configured, with this user
// linked through it. `isEnabled` is the deployment-level question asked
// before the per-user one — see connector-config-unset.test.js for the
// unconfigured deployment. The link is a LOGIN and nothing else: there is no
// token for a fake to hand out.
const linkedAs = (login) => ({
  isEnabled: () => true,
  linkStatus: async () => ({ linked: true, login, linkedAt: null, access: 'identity' }),
});

// ── Agent vocabulary ───────────────────────────────────────────────────

test('the agent label is a closed vocabulary, inferred from the client', () => {
  assert.equal(svc.normalizeAgent('claude-code'), 'claude-code');
  assert.equal(svc.normalizeAgent('codex'), 'codex');
  // Inferred from the connected chat product when the tool call omits it.
  assert.equal(svc.normalizeAgent(null, 'Claude'), 'claude-code');
  assert.equal(svc.normalizeAgent(null, 'ChatGPT'), 'codex');
  assert.equal(svc.normalizeAgent(null, 'Some MCP Client'), 'external');
  // Anything a connector invents collapses to the generic label rather
  // than reaching the database, and therefore the badge.
  assert.equal(svc.normalizeAgent('Anthropic Ultra Deluxe'), 'external');
  assert.equal(svc.normalizeAgent('<script>alert(1)</script>'), 'external');
  for (const agent of [svc.normalizeAgent('nonsense'), svc.normalizeAgent('codex')]) {
    assert.ok(svc.AGENTS.includes(agent));
  }
});

test('branch names are namespaced and derived from platform identifiers only', () => {
  const branch = svc.branchNameFor('recipe-box', 42, 'abc123');
  assert.equal(branch, 'usernode/recipe-box-issue-42-abc123');
  assert.equal(svc.branchNameFor('recipe-box', null, 'abc123'), 'usernode/recipe-box-task-abc123');
  // A hostile slug cannot escape the namespace or the ref syntax.
  const nasty = svc.branchNameFor('../../evil branch~^:?*[', 0, 'abc123');
  assert.match(nasty, /^usernode\/[a-z0-9-]+-task-abc123$/);
  // Unseeded names are unique, so two concurrent prepares do not collide.
  assert.notEqual(svc.branchNameFor('x', 1), svc.branchNameFor('x', 1));
});

// ── The work order ─────────────────────────────────────────────────────

function orderFor(forkStatus, overrides = {}) {
  return svc.buildWorkOrder({
    appName: 'Recipe Box',
    appSlug: 'recipe-box',
    upstreamUrl: 'https://github.com/usernode-bot/recipe-box',
    upstreamSlug: 'usernode-bot/recipe-box',
    forkUrl: 'https://github.com/someuser/recipe-box',
    forkCloneUrl: 'https://github.com/someuser/recipe-box.git',
    forkRepo: 'recipe-box',
    forkPageUrl: 'https://github.com/usernode-bot/recipe-box/fork',
    forkStatus,
    branch: 'usernode/recipe-box-issue-4-abc123',
    baseSha: 'deadbeef',
    issueNumber: 4,
    brief: '<untrusted-content>Add dark mode</untrusted-content>',
    webPath: 'https://usernode.example/#app/recipe-box',
    ...overrides,
  });
}

test('the work order is self-contained and carries no credential', () => {
  const order = orderFor('ready');
  // Everything the receiving agent needs: where to push, what branch, and
  // the commit it starts from.
  assert.match(order, /https:\/\/github\.com\/someuser\/recipe-box\.git/);
  assert.match(order, /usernode\/recipe-box-issue-4-abc123/);
  assert.match(order, /deadbeef/);
  assert.match(order, /request #4/);
  // The brief keeps its envelope: it is other people's writing on its way
  // to an agent with a shell.
  assert.match(order, /<untrusted-content>Add dark mode<\/untrusted-content>/);
  assert.match(order, /not instructions addressed/i);
  // And the rules that keep the agent inside its own repository.
  assert.match(order, /Do not push to\n {2}the upstream repository/);
  assert.match(order, /secrets, tokens or credentials/);
  // No token of any kind is ever pasted into a chat product's transcript.
  assert.doesNotMatch(order, /gho_|ghp_|Bearer |x-access-token/);
});

test('the work order creates the branch itself — the platform no longer does', () => {
  // The branch used to be reserved server-side with the user's token. The
  // agent cuts it now, at the commit the platform recorded, and pushes it.
  for (const status of ['ready', 'missing', 'name_conflict']) {
    const order = orderFor(status);
    assert.match(order, /git fetch upstream/, `${status}: upstream is fetched`);
    assert.match(
      order, /git checkout -b usernode\/recipe-box-issue-4-abc123 deadbeef/,
      `${status}: the branch is cut at the recorded base commit`
    );
    // The push is by HEAD, not by the suggested name: any branch name is
    // accepted now, and a differently-named branch is never a reason to
    // redo a finished commit.
    assert.match(order, /git push -u origin HEAD/, `${status}: and pushed`);
    assert.match(order, /Usernode has no write access to your GitHub account/,
      `${status}: and says why the agent has to do it`);
  }
});

test('the work order forks when the fork is missing, and leads with the one-click link', () => {
  const missing = orderFor('missing');
  // Create-only: the shared block below does the cloning, so the CLI form
  // must not clone a second working copy.
  assert.match(missing, /gh repo fork usernode-bot\/recipe-box --clone=false/);
  assert.doesNotMatch(missing, /gh repo fork [^\n]*--clone(?!=false)/);
  // The human fallback for an agent with no `gh`: GitHub's own fork page —
  // and it comes FIRST now, above the command it replaces.
  assert.match(missing, /https:\/\/github\.com\/usernode-bot\/recipe-box\/fork/);
  assert.match(missing, /Create fork/);
  assert.ok(
    missing.indexOf('https://github.com/usernode-bot/recipe-box/fork')
      < missing.indexOf('gh repo fork'),
    'the one-click link is offered before the CLI command'
  );
  assert.ok(
    missing.indexOf('https://github.com/usernode-bot/recipe-box/fork')
      < missing.indexOf('git clone'),
    'and before the clone it has to happen before'
  );

  // A fork that already exists needs no fork step at all — but the fallback
  // link stays, since our read of GitHub is advisory.
  const ready = orderFor('ready');
  assert.match(ready, /git clone https:\/\/github\.com\/someuser\/recipe-box\.git/);
  assert.doesNotMatch(ready, /gh repo fork/);
  assert.match(ready, /https:\/\/github\.com\/usernode-bot\/recipe-box\/fork/);
});

test('a same-named repo in the way becomes a differently-named fork, never a refusal', () => {
  const order = orderFor('name_conflict', {
    forkRepo: 'recipe-box-usernode',
    forkUrl: 'https://github.com/someuser/recipe-box-usernode',
    forkCloneUrl: 'https://github.com/someuser/recipe-box-usernode.git',
  });
  assert.match(order, /--fork-name recipe-box-usernode/);
  assert.match(order, /cd recipe-box-usernode/);
  assert.match(order, /never touches that other repository/i);
  // Forking by hand needs the name changed on GitHub's own page, so the
  // one-click route says which name to type.
  assert.match(order, /change the repository-name field to\s+recipe-box-usernode/);
});

test('the setup commands are the same four in every fork state', () => {
  // The three paths used to diverge — one cloned into a directory called
  // `app`, the others fork-and-cloned — so nobody could see they ended in
  // the same place. Only the fork's own address varies now.
  for (const status of ['ready', 'missing', 'name_conflict']) {
    const order = orderFor(status);
    const want = [
      'git clone https://github.com/someuser/recipe-box.git recipe-box',
      'cd recipe-box',
      'git remote add upstream https://github.com/usernode-bot/recipe-box',
      'git fetch upstream',
      'git checkout -b usernode/recipe-box-issue-4-abc123 deadbeef',
    ];
    let at = -1;
    for (const cmd of want) {
      const found = order.indexOf(cmd, at + 1);
      assert.ok(found > at, `${status}: ${cmd} appears, in order`);
      at = found;
    }
    // The old ready-path quirk: a working directory named after nothing.
    assert.doesNotMatch(order, /git clone \S+ app &&/, `${status}: no 'app' directory`);
  }
});

test('the work order tells the agent how to recover a commit id git rejects', () => {
  for (const status of ['ready', 'missing', 'name_conflict']) {
    const order = orderFor(status);
    assert.match(order, /fatal: not a valid object name/, `${status}: names the failure`);
    assert.match(order, /reference is not a tree/, `${status}: and the other one`);
    assert.match(order, /git fetch upstream deadbeef/, `${status}: and the recovery`);
    assert.match(order, /Do not shorten that commit id/, `${status}: no shortening`);
    assert.match(order, /substitute `upstream\/main` or `HEAD`/, `${status}: no substitute`);
    assert.match(order, /ask for the work order again/, `${status}: and an escape hatch`);
  }
});

test('a work order with no brief tells the agent to ask rather than guess', () => {
  const order = svc.buildWorkOrder({
    appName: 'A', appSlug: 'a', upstreamUrl: 'u', upstreamSlug: 'o/a', forkUrl: 'f',
    forkCloneUrl: 'f.git', forkRepo: 'a', forkPageUrl: 'p', forkStatus: 'missing',
    branch: 'b', baseSha: 's', brief: '',
  });
  assert.match(order, /ask the user what they want before writing code/);
});

// ── The attribution gate ───────────────────────────────────────────────

test('attribution: only a pull request from the caller’s own fork passes', () => {
  const fromMe = { head: { repo: { owner: { login: 'SomeUser' } } } };
  // GitHub logins are case-preserving, not case-sensitive.
  assert.equal(svc.attributionError(fromMe, 'someuser'), null);
  assert.equal(svc.attributionError(fromMe, 'SomeUser'), null);

  const fromSomeoneElse = { head: { repo: { owner: { login: 'attacker' } } } };
  const err = svc.attributionError(fromSomeoneElse, 'someuser');
  assert.equal(err.ok, false);
  assert.equal(err.code, 'fork_mismatch');
  assert.match(err.message, /attacker's repository/);
  assert.match(err.message, /import it from the app’s Dev page|import it from the app's Dev page/);

  // Head repo deleted: GitHub keeps the owner in the label, and that is
  // still enough to refuse — it must never fall through to "allowed".
  assert.equal(svc.headOwnerOf({ head: { label: 'attacker:feat/x' } }), 'attacker');
  assert.equal(svc.attributionError({ head: { label: 'attacker:feat/x' } }, 'someuser').code, 'fork_mismatch');
  // No head information at all is a refusal, not a pass.
  assert.equal(svc.attributionError({}, 'someuser').code, 'fork_mismatch');
  assert.equal(svc.attributionError(null, 'someuser').code, 'fork_mismatch');
  // And an empty verified login can never match an empty head owner.
  assert.equal(svc.attributionError({ head: { repo: { owner: { login: '' } } } }, '').code, 'fork_mismatch');
});

// ── inspectFork ────────────────────────────────────────────────────────

test('inspecting the fork is one PUBLIC read and never a write', async () => {
  const calls = [];
  await withFetch({
    'GET /repos/someuser/recipe-box': {
      status: 200,
      body: { fork: true, name: 'recipe-box', parent: { full_name: 'usernode-bot/recipe-box' } },
    },
  }, calls, async () => {
    const result = await svc.inspectFork('someuser', { owner: 'usernode-bot', repo: 'recipe-box' });
    assert.equal(result.state, 'ready');
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, 'GET /repos/someuser/recipe-box');
  // No user credential exists to send. The bot PAT may authenticate the read
  // for rate-limit headroom, but nothing user-scoped is ever attached.
  const auth = calls[0].headers.Authorization || calls[0].headers.authorization;
  assert.ok(!auth || /^Bearer /.test(auth) === false || auth === `Bearer ${process.env.GITHUB_BOT_TOKEN}`,
    'only the platform’s own public-read credential, if any');
});

test('a same-named repo that is not our fork is a named conflict, never touched', async () => {
  const calls = [];
  await withFetch({
    'GET /repos/someuser/recipe-box': { status: 200, body: { fork: false, name: 'recipe-box' } },
  }, calls, async () => {
    const result = await svc.inspectFork('someuser', { owner: 'usernode-bot', repo: 'recipe-box' });
    assert.equal(result.state, 'name_conflict');
  });
  assert.equal(calls.length, 1, 'nothing is written to that repository');

  // A fork of a DIFFERENT upstream with the same name is also a conflict.
  const calls2 = [];
  await withFetch({
    'GET /repos/someuser/recipe-box': {
      status: 200, body: { fork: true, name: 'recipe-box', parent: { full_name: 'elsewhere/recipe-box' } },
    },
  }, calls2, async () => {
    const result = await svc.inspectFork('someuser', { owner: 'usernode-bot', repo: 'recipe-box' });
    assert.equal(result.state, 'name_conflict');
  });
});

test('a missing fork is `missing`, and an unreadable GitHub is `unknown`', async () => {
  await withFetch({
    'GET /repos/someuser/recipe-box': { status: 404, body: { message: 'Not Found' } },
  }, [], async () => {
    const result = await svc.inspectFork('someuser', { owner: 'usernode-bot', repo: 'recipe-box' });
    assert.equal(result.state, 'missing');
  });

  // A rate-limited or down GitHub must not become a refusal: the work
  // order's fork command is a no-op when the fork already exists.
  const original = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const result = await svc.inspectFork('someuser', { owner: 'usernode-bot', repo: 'recipe-box' });
    assert.equal(result.state, 'unknown');
  } finally {
    global.fetch = original;
  }
});

// ── prepareWork ────────────────────────────────────────────────────────

const FORK_READY = {
  'GET /repos/someuser/recipe-box': {
    status: 200,
    body: { fork: true, name: 'recipe-box', parent: { full_name: 'usernode-bot/recipe-box' } },
  },
};

test('prepare_work records the work order at the UPSTREAM base commit', async () => {
  const queries = [];
  const calls = [];
  const pool = fakePool([['INSERT INTO external_agent_tasks', [{ id: 31 }]]], queries);
  const result = await withFetch(FORK_READY, calls, () => svc.prepareWork(
    { pool, config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, app: APP, issueNumber: 4,
      brief: '<untrusted-content>Add dark mode</untrusted-content>',
      clientId: 'claude-ai', clientName: 'Claude — claude.ai',
      origin: 'https://usernode.example',
    }
  ));

  assert.equal(result.ok, true);
  assert.equal(result.taskId, 31);
  assert.equal(result.forkOwner, 'someuser');
  assert.equal(result.forkStatus, 'ready');
  assert.equal(result.baseSha, BASE_SHA);
  assert.match(result.branch, /^usernode\/recipe-box-issue-4-/);

  // The base commit comes from UPSTREAM, read with the platform's own
  // credentials — never from the fork, which may be stale or edited — and it
  // is what the work order tells the agent to branch from.
  assert.match(
    result.workOrder,
    new RegExp(`git checkout -b ${result.branch} ${BASE_SHA}`)
  );

  // An existing fork drops the fork step: open, choose, paste, hand back.
  assert.equal(result.guidance.length, 4);
  assert.ok(!result.guidance.some((s) => s.includes('/fork')), 'no fork step when one exists');
  assert.match(result.guidance[0], /claude\.ai\/code/);
  assert.match(result.guidance[0], /new session/i);
  assert.match(result.guidance[1], /repository picker/i);
  assert.ok(result.guidance[1].includes('someuser/recipe-box'));
  assert.ok(!/the copy you just made/.test(result.guidance[1]), 'they did not just make it');

  // Nothing is written to GitHub at all: one read, no more.
  assert.deepEqual(calls.map((c) => c.key), ['GET /repos/someuser/recipe-box']);
  assert.equal(calls.filter((c) => c.body !== null).length, 0, 'no request has a body');

  // The row records the work order so submit_work can find it again.
  const insert = queries.find((q) => q.sql.includes('INSERT INTO external_agent_tasks'));
  assert.deepEqual(insert.params.slice(0, 3), [3, 7, 4]);
  assert.equal(insert.params[5], result.branch);
});

test('a missing fork still produces a work order — it is the agent’s job now', async () => {
  const queries = [];
  const pool = fakePool([['INSERT INTO external_agent_tasks', [{ id: 32 }]]], queries);
  const result = await withFetch({
    'GET /repos/someuser/recipe-box': { status: 404, body: { message: 'Not Found' } },
  }, [], () => svc.prepareWork(
    { pool, config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, app: APP, brief: 'x',
      clientName: 'Claude — claude.ai', origin: 'https://usernode.example',
    }
  ));

  assert.equal(result.ok, true, 'a missing fork is not a refusal');
  assert.equal(result.forkStatus, 'missing');
  assert.equal(result.forkPageUrl, 'https://github.com/usernode-bot/recipe-box/fork');
  assert.match(result.workOrder, /gh repo fork usernode-bot\/recipe-box/);
  assert.match(result.workOrder, /https:\/\/github\.com\/usernode-bot\/recipe-box\/fork/);

  // Making the copy is step ONE, and it is not skippable: both hosted
  // agents start a session by PICKING a repository that already exists in
  // the user's account, so "your agent will fork for you" would send a web
  // user to a picker with nothing in it.
  assert.equal(result.guidance.length, 5);
  assert.ok(result.guidance[0].includes(result.forkPageUrl));
  assert.doesNotMatch(result.guidance[0], /skip|GitHub CLI|\bgh\b/i);
  assert.match(result.guidance[1], /claude\.ai\/code/);
  assert.match(result.guidance[2], /the copy you just made/);

  // The one-click link leads SETUP rather than trailing it as a fallback.
  const setupAt = result.workOrder.indexOf('SETUP');
  assert.ok(setupAt > 0);
  assert.ok(result.workOrder.indexOf(result.forkPageUrl) > setupAt);
  assert.ok(result.workOrder.indexOf(result.forkPageUrl) < result.workOrder.indexOf('git clone'));

  // The reservation exists, so a retry after the user clicks "Create fork"
  // needs no new task row.
  assert.ok(queries.some((q) => q.sql.includes('INSERT INTO external_agent_tasks')));
});

test('a name conflict suggests another fork name instead of refusing', async () => {
  const queries = [];
  const pool = fakePool([['INSERT INTO external_agent_tasks', [{ id: 33 }]]], queries);
  const result = await withFetch({
    'GET /repos/someuser/recipe-box': { status: 200, body: { fork: false, name: 'recipe-box' } },
  }, [], () => svc.prepareWork(
    { pool, config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, app: APP, brief: 'x',
      clientName: 'Claude — claude.ai', origin: 'https://usernode.example',
    }
  ));

  assert.equal(result.ok, true);
  assert.equal(result.forkStatus, 'name_conflict');
  assert.equal(result.forkRepo, 'recipe-box-usernode');
  assert.match(result.workOrder, /--fork-name recipe-box-usernode/);

  // The human's step names the OTHER name and says the existing repository
  // is left alone — the reassurance is the point of the step.
  assert.equal(result.guidance.length, 5);
  assert.ok(result.guidance[0].includes(result.forkPageUrl));
  assert.ok(result.guidance[0].includes('recipe-box-usernode'));
  assert.match(result.guidance[0], /never touches/);
  assert.ok(result.guidance[2].includes('someuser/recipe-box-usernode'));

  // The task row carries the suggested name as a HINT; the attribution gate
  // still only checks the owner, so another name works too.
  const insert = queries.find((q) => q.sql.includes('INSERT INTO external_agent_tasks'));
  assert.equal(insert.params[4], 'recipe-box-usernode');
  assert.equal(insert.params[3], 'someuser');
});

// ── The hand-off text ──────────────────────────────────────────────────

const prepareWith = (params, fetchMap = FORK_READY) => withFetch(
  fetchMap, [], () => svc.prepareWork(
    {
      pool: fakePool([['INSERT INTO external_agent_tasks', [{ id: 40 }]]], []),
      config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits,
    },
    { user: { id: 3 }, app: APP, brief: 'x', origin: 'https://usernode.example', ...params }
  )
);

const FORK_MISSING = {
  'GET /repos/someuser/recipe-box': { status: 404, body: { message: 'Not Found' } },
};

test('every guidance step is an action the HUMAN takes, never agent narration', async () => {
  for (const clientName of ['Claude — claude.ai', 'ChatGPT — chatgpt.com', null]) {
    const result = await prepareWith({ clientName }, FORK_MISSING);
    assert.equal(result.ok, true);

    for (const step of result.guidance) {
      // "It will clone your fork, create the branch and push; it will not
      // open a pull request" was a line to read and nothing to do — every
      // clause of it is already in the work order, addressed to the agent.
      assert.doesNotMatch(step, /will clone|create the branch|pull request|it will /i,
        `guidance must not narrate the agent: ${step}`);
      // Short enough to survive a host model's urge to reflow it, and free
      // of anything that reads as a command for the person to run.
      assert.ok(step.length <= svc.MAX_GUIDANCE_CHARS, `too long: ${step}`);
      assert.ok(!step.includes('$'), `no shell in guidance: ${step}`);
      assert.ok(!step.includes('```'), `no fenced block in guidance: ${step}`);
      assert.ok(!step.includes('git '), `no git commands in guidance: ${step}`);
      assert.ok(!/^\s*\d+[.)]/.test(step), `unnumbered — the host numbers them: ${step}`);
    }

    // The hand-off back to this conversation is always last — and it now
    // sets the expectation that the coding agent submits for ITSELF, since
    // the Usernode connector is attached to the account rather than to one
    // conversation. The human is told what to expect and when to come back,
    // not asked to relay a branch name.
    assert.match(result.guidance[result.guidance.length - 1], /submit the change to Usernode itself/);
    assert.match(result.guidance[result.guidance.length - 1], /can't submit/);
    assert.match(result.guidance[result.guidance.length - 2], /exactly as written/);
  }
});

test('guidance names the actual web UI of the client that called it', async () => {
  const claude = await prepareWith({ clientName: 'Claude — claude.ai' }, FORK_MISSING);
  assert.match(claude.guidance[1], /Open https:\/\/claude\.ai\/code and start a new session\./);
  assert.match(claude.guidance[2], /repository picker/i);
  assert.ok(claude.guidance[2].includes('someuser/recipe-box'));

  const codex = await prepareWith({ clientName: 'ChatGPT — chatgpt.com' }, FORK_MISSING);
  assert.match(codex.guidance[1], /Open https:\/\/chatgpt\.com\/codex and start a new task\./);
  assert.ok(codex.guidance[2].includes('someuser/recipe-box'));
  assert.equal(codex.guidance.length, 5);

  // An unrecognised client gets the one thing true everywhere — and is the
  // only variant where a terminal is likely enough to mention the CLI.
  const other = await prepareWith({ clientName: 'some-cli/0.1' }, FORK_MISSING);
  assert.equal(other.guidance.length, 4, 'open + choose collapse into one step');
  assert.ok(other.guidance[1].includes('someuser/recipe-box'));
  assert.match(other.guidance[1], /cloning it first/);
  assert.match(other.guidance[0], /GitHub CLI/);
});

test('an explicitly chosen agent beats sniffing the calling client', async () => {
  // #1049: the in-platform flow picker KNOWS which agent the user chose —
  // the browser is the calling client, so there is no client name to sniff
  // and every prepared task would otherwise come back as 'external', with
  // guidance that names no product and a badge that names no agent.
  for (const agent of ['claude-code', 'codex']) {
    const picked = await prepareWith({ agent, clientName: 'Usernode' }, FORK_MISSING);
    assert.equal(picked.ok, true);
    assert.equal(picked.agent, agent, 'the resolved agent comes back to the caller');
    assert.equal(picked.guidance.length, 5, 'the hosted-web-UI guidance, not the generic four');
  }
  assert.match(
    (await prepareWith({ agent: 'claude-code', clientName: 'Usernode' }, FORK_MISSING)).guidance[1],
    /https:\/\/claude\.ai\/code/,
  );
  assert.match(
    (await prepareWith({ agent: 'codex', clientName: 'Usernode' }, FORK_MISSING)).guidance[1],
    /https:\/\/chatgpt\.com\/codex/,
  );

  // Explicit wins even when the client name says otherwise: an MCP client
  // that offers its user a choice must be able to honour it.
  const override = await prepareWith(
    { agent: 'codex', clientName: 'Claude — claude.ai' }, FORK_MISSING
  );
  assert.equal(override.agent, 'codex');
  assert.match(override.guidance[1], /chatgpt\.com\/codex/);

  // And with nothing explicit, the inference is byte-for-byte what it was.
  const sniffed = await prepareWith({ clientName: 'Claude — claude.ai' }, FORK_MISSING);
  assert.equal(sniffed.agent, 'claude-code');
  const garbage = await prepareWith({ agent: 'not-an-agent', clientName: 'x' }, FORK_MISSING);
  assert.equal(garbage.agent, 'external', 'an unknown value falls back, it does not leak through');
});

test('the browser flow round-trips its agent through client_id', async () => {
  // There is no `agent` column on external_agent_tasks, and #1049 did not
  // add one: src/routes/dev-flow.js records the picked agent in client_id as
  // 'usernode-web:<agent>', and normalizeAgent recovers it from that on a
  // later read. This is what makes the walkthrough resumable — reload the
  // page and the card still says "Building with Codex".
  const ROUTE_SRC = fs.readFileSync(
    path.join(__dirname, '../src/routes/dev-flow.js'), 'utf8'
  );
  assert.match(ROUTE_SRC, /usernode-web:/, 'the route stamps the agent into client_id');
  assert.equal(svc.normalizeAgent(null, 'usernode-web:claude-code'), 'claude-code');
  assert.equal(svc.normalizeAgent(null, 'usernode-web:codex'), 'codex');

  // Proof of the whole loop: a task row whose only record of the agent is
  // client_id renders with the right product name.
  const rendered = svc.renderPreparedTask({
    task: {
      id: 77, fork_owner: 'someuser', fork_repo: 'recipe-box',
      branch_name: 'usernode/x', base_sha: BASE_SHA, issue_number: null, brief: 'x',
    },
    app: APP, owner: 'usernode-bot', repo: 'recipe-box',
    origin: 'https://usernode.example',
    clientId: 'usernode-web:codex', clientName: null,
    forkStatus: 'ready', reused: true,
  });
  assert.equal(rendered.agent, 'codex');
  assert.match(rendered.guidance.join('\n'), /chatgpt\.com\/codex/);
});

test('the work order is addressed to the agent and to nobody else', async () => {
  const result = await prepareWith({ clientName: 'Claude — claude.ai' });
  for (const human of ['tell the assistant', 'paste', 'verbatim', 'come back']) {
    assert.ok(!result.workOrder.toLowerCase().includes(human),
      `the work order must not address the human: ${human}`);
  }
  // One canonical command block, whatever the fork state.
  assert.match(result.workOrder, /git clone https:\/\/github\.com\/someuser\/recipe-box\.git recipe-box/);
  assert.match(result.workOrder, /git remote add upstream https:\/\/github\.com\/usernode-bot\/recipe-box/);
  // And it still forbids opening the pull request on the normal path —
  // Usernode opens it, so the change arrives as a proposal with a preview,
  // checks and a vote rather than a bare PR nobody is voting on.
  assert.match(result.workOrder, /Do not open the pull request yourself in the normal path/);
});

test('the base commit renders as one unbroken 40-character word', async () => {
  for (const fetchMap of [FORK_READY, FORK_MISSING]) {
    const result = await prepareWith({ clientName: 'Claude — claude.ai' }, fetchMap);
    // Commands are four-space-indented lines now, not fenced blocks: the
    // host wraps the whole work order in a fence and an inner fence closed
    // it early, which is how a pasted copy reached Claude Code with every
    // command flattened into prose. The anchor gains `\s+`; the assertion
    // it guards — one shape, exactly twice — is unchanged.
    const checkouts = result.workOrder
      .split('\n')
      .filter((l) => /^\s+git checkout -b \S+ [0-9a-f]{40}$/.test(l));
    // Once in SETUP, once in the recovery block — same shape both times.
    assert.equal(checkouts.length, 2, 'every checkout line has exactly one shape');
    // The failure this guards: a commit id split by a stray space. Nothing
    // in a generated work order should ever look like two hex runs.
    for (const line of result.workOrder.split('\n')) {
      assert.doesNotMatch(line, /[0-9a-f]{8,}\s+[0-9a-f]{8,}/, `split hex id: ${line}`);
    }
    // The invariant is stated where the agent can act on it.
    assert.match(result.workOrder, /all 40 characters, exactly as written/);
    assert.match(result.workOrder, /substitute `upstream\/main` or `HEAD`/);
  }
});

test('a base commit that is not a clean 40-hex id never reaches a work order', async () => {
  for (const bad of [`ba5e0000000000 ${'0'.repeat(20)}fe`, 'ba5e0000', 'not-a-sha', '']) {
    const queries = [];
    const pool = fakePool([['INSERT INTO external_agent_tasks', [{ id: 41 }]]], queries);
    const result = await withFetch(FORK_READY, [], () => svc.prepareWork(
      {
        pool,
        config: {},
        gh: baseGh({ getBranchSha: async () => bad }),
        githubLink: linkedAs('someuser'),
        limits: okLimits,
      },
      { user: { id: 3 }, app: APP, brief: 'x', origin: 'https://usernode.example' }
    ));
    assert.equal(result.ok, false, `must refuse ${JSON.stringify(bad)}`);
    assert.equal(result.code, 'platform_unavailable');
    assert.ok(!queries.some((q) => q.sql.includes('INSERT INTO external_agent_tasks')),
      'and no task row is reserved against a commit that cannot be branched from');
  }
});

test('prepare_work refuses before touching GitHub when the account is not linked', async () => {
  const queries = [];
  let fetched = false;
  const original = global.fetch;
  global.fetch = async () => { fetched = true; throw new Error('should not be called'); };
  try {
    const result = await svc.prepareWork(
      {
        pool: fakePool([], queries), config: {}, gh: baseGh(),
        githubLink: {
          isEnabled: () => true,
          linkStatus: async () => ({ linked: false, login: null, linkedAt: null, access: 'identity' }),
        },
        limits: okLimits,
      },
      { user: { id: 3 }, app: APP, brief: 'x', origin: 'https://usernode.example' }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'github_not_linked');
    assert.equal(result.settingsUrl, 'https://usernode.example/#settings/connectors');
    // And it says what the link actually asks for, since that is the whole
    // question a user hesitating over the button has.
    assert.match(result.message, /no access to your repositories/);
    assert.equal(fetched, false);
    assert.equal(queries.length, 0, 'and nothing is recorded');
  } finally {
    global.fetch = original;
  }
});

test('prepare_work returns guidance beside the work order', async () => {
  const queries = [];
  const pool = fakePool([['INSERT INTO external_agent_tasks', [{ id: 34 }]]], queries);
  const result = await withFetch({
    'GET /repos/someuser/recipe-box': { status: 404, body: { message: 'Not Found' } },
  }, [], () => svc.prepareWork(
    { pool, config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, app: APP, brief: '<untrusted-content>Add dark mode</untrusted-content>',
      clientName: 'Claude', origin: 'https://usernode.example',
    }
  ));

  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.guidance));
  assert.match(result.guidance[0], /https:\/\/github\.com\/usernode-bot\/recipe-box\/fork/);
  // Named from the connected chat product, and free of the user-authored
  // brief that the work order carries under its envelope.
  assert.match(result.guidance.join('\n'), /claude\.ai\/code/);
  assert.doesNotMatch(result.guidance.join('\n'), /Add dark mode/);
  assert.match(result.workOrder, /<untrusted-content>Add dark mode<\/untrusted-content>/);
});

test('a base commit that is not a commit id is refused, not pasted into a work order', async () => {
  for (const bad of ['', 'abc123', 'z'.repeat(40), '0123456789abcdef0123456789abcdef0123456', null]) {
    const queries = [];
    let fetched = false;
    const original = global.fetch;
    global.fetch = async () => { fetched = true; throw new Error('should not be called'); };
    try {
      const result = await svc.prepareWork(
        {
          pool: fakePool([], queries), config: {},
          gh: baseGh({ getBranchSha: async () => bad }),
          githubLink: linkedAs('someuser'), limits: okLimits,
        },
        { user: { id: 3 }, app: APP, brief: 'x', origin: 'https://usernode.example' }
      );
      assert.equal(result.ok, false, `${JSON.stringify(bad)} is refused`);
      assert.equal(result.code, 'platform_unavailable');
      assert.equal(result.retryable, true);
      assert.equal(fetched, false, 'and GitHub is never read for the fork');
      // The idempotency lookup is a read and may run first — what must not
      // happen is a RESERVATION against a commit nobody can branch from.
      assert.ok(!queries.some((q) => /INSERT INTO|UPDATE /.test(q.sql)), 'and nothing is reserved');
    } finally {
      global.fetch = original;
    }
  }
});

test('an upper-case commit id is accepted and recorded lowercased', async () => {
  const queries = [];
  const pool = fakePool([['INSERT INTO external_agent_tasks', [{ id: 35 }]]], queries);
  const result = await withFetch(FORK_READY, [], () => svc.prepareWork(
    {
      pool, config: {},
      gh: baseGh({ getBranchSha: async () => '0123456789ABCDEF0123456789ABCDEF01234567' }),
      githubLink: linkedAs('someuser'), limits: okLimits,
    },
    { user: { id: 3 }, app: APP, brief: 'x', origin: 'https://usernode.example' }
  ));

  assert.equal(result.ok, true);
  assert.equal(result.baseSha, '0123456789abcdef0123456789abcdef01234567');
  const insert = queries.find((q) => q.sql.includes('INSERT INTO external_agent_tasks'));
  assert.equal(insert.params[6], '0123456789abcdef0123456789abcdef01234567');
  assert.match(result.workOrder, /0123456789abcdef0123456789abcdef01234567/);
});

test('prepare_work is bounded before it records anything', async () => {
  const queries = [];
  let fetched = false;
  const original = global.fetch;
  global.fetch = async () => { fetched = true; throw new Error('should not be called'); };
  try {
    const result = await svc.prepareWork(
      {
        pool: fakePool([], queries), config: {}, gh: baseGh(),
        githubLink: linkedAs('someuser'),
        limits: { ...okLimits, checkPrepareRate: async () => ({ code: 'at_capacity', message: 'Slow down.' }) },
      },
      { user: { id: 3 }, app: APP, brief: 'x', origin: 'https://usernode.example' }
    );
    assert.equal(result.code, 'at_capacity');
    assert.equal(result.retryable, true);
    assert.equal(fetched, false, 'a rate-limited caller never reaches GitHub');
    assert.ok(!queries.some((q) => /INSERT INTO|UPDATE /.test(q.sql)), 'and nothing is recorded');
  } finally {
    global.fetch = original;
  }
});

// ── submitWork ─────────────────────────────────────────────────────────

const TASK_ROW = {
  id: 31, user_id: 3, app_id: 7, issue_number: 4,
  fork_owner: 'someuser', fork_repo: 'recipe-box',
  branch_name: 'usernode/recipe-box-issue-4-abc123',
  base_sha: '0123456789abcdef0123456789abcdef01234567',
  brief: 'Add dark mode', status: 'open',
  app_slug: 'recipe-box', app_name: 'Recipe Box',
  repo_url: 'https://github.com/usernode-bot/recipe-box',
};

const PUSHED_BRANCH = {
  'GET /repos/someuser/recipe-box/branches/usernode%2Frecipe-box-issue-4-abc123': {
    status: 200, body: { commit: { sha: '89abcdef0123456789abcdef0123456789abcdef' } },
  },
};

function submitPool(queries, extra = []) {
  return fakePool([
    ['FROM external_agent_tasks t JOIN apps a', [TASK_ROW]],
    ['UPDATE chat_sessions SET external_agent', []],
    ['UPDATE external_agent_tasks', []],
    ...extra,
  ], queries);
}

test('submit_work opens the cross-fork PR and stamps the agent on the session', async () => {
  const queries = [];
  const calls = [];
  const created = [];
  const imports = [];
  const gh = baseGh({
    findOpenPrByBranch: async () => null,
    createPR: async (owner, repo, opts) => {
      created.push({ owner, repo, opts });
      return { number: 88, html_url: 'https://github.com/usernode-bot/recipe-box/pull/88', head: { repo: { owner: { login: 'SomeUser' } } } };
    },
  });

  const result = await withFetch(PUSHED_BRANCH, calls, () => svc.submitWork(
    { pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, clientName: 'Claude', taskId: 31, title: 'Dark mode',
      body: 'Adds a toggle.',
      importProposal: async (slug, prNumber) => {
        imports.push({ slug, prNumber });
        return { ok: true, status: 200, body: { sessionId: 55 } };
      },
    }
  ));

  assert.equal(result.ok, true);
  assert.equal(result.proposalId, 55);
  assert.equal(result.prNumber, 88);
  assert.equal(result.externalAgent, 'claude-code');

  // The PR targets the app's repo but its head is the user's fork.
  assert.equal(created[0].owner, 'usernode-bot');
  assert.equal(created[0].opts.head, 'someuser:usernode/recipe-box-issue-4-abc123');

  // The proposal is made by the platform's own import route, replaying the
  // caller's token — this service never inserts a chat_sessions row itself.
  assert.deepEqual(imports, [{ slug: 'recipe-box', prNumber: 88 }]);
  assert.doesNotMatch(SRC, /INSERT INTO chat_sessions/);

  // The only thing stamped afterwards is the badge column, scoped to the
  // caller's own row. source is untouched, so an imported proposal keeps
  // behaving like one.
  const stamp = queries.find((q) => q.sql.includes('UPDATE chat_sessions SET external_agent'));
  assert.deepEqual(stamp.params, ['claude-code', 55, 3]);
  assert.doesNotMatch(SRC, /source\s*=\s*'(?!imported)/);
  assert.doesNotMatch(SRC, /SET source/);

  // And the reservation is closed so it stops counting against the caps.
  const close = queries.find((q) => q.sql.includes('UPDATE external_agent_tasks'));
  assert.match(close.sql, /status = 'submitted'/);
});

test('submit_work refuses a pull request from someone else’s fork before importing', async () => {
  const queries = [];
  const calls = [];
  let imported = false;
  const gh = baseGh({
    findOpenPrByBranch: async () => ({
      number: 90, html_url: 'x', head: { repo: { owner: { login: 'attacker' } } },
    }),
    createPR: async () => { throw new Error('should not create'); },
  });

  const result = await withFetch(PUSHED_BRANCH, calls, () => svc.submitWork(
    { pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, taskId: 31,
      importProposal: async () => { imported = true; return { ok: true, body: {} }; },
    }
  ));

  assert.equal(result.code, 'fork_mismatch');
  assert.equal(imported, false, 'the platform is never asked to import it');
  assert.ok(!queries.some((q) => q.sql.includes('UPDATE chat_sessions')));
});

test('submitting an already-open pull request by number is gated the same way', async () => {
  const queries = [];
  let imported = false;
  const gh = baseGh({
    getPR: async () => ({ number: 77, state: 'open', head: { repo: { owner: { login: 'someone-else' } } } }),
  });
  const result = await svc.submitWork(
    { pool: fakePool([], queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, prNumber: 77, slug: 'recipe-box',
      repoUrl: 'https://github.com/usernode-bot/recipe-box',
      importProposal: async () => { imported = true; return { ok: true, body: {} }; },
    }
  );
  assert.equal(result.code, 'fork_mismatch');
  assert.equal(imported, false);
});

test('the promoted-session cap is applied before a pull request is opened', async () => {
  const queries = [];
  let createdPr = false;
  const gh = baseGh({
    findOpenPrByBranch: async () => null,
    createPR: async () => { createdPr = true; return { number: 1 }; },
  });
  const result = await svc.submitWork(
    {
      pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'),
      limits: {
        ...okLimits,
        checkPromotedCap: async () => ({
          code: 'at_capacity',
          message: 'You already have 5 PRs up for vote. Wait for one to merge, or archive one first.',
        }),
      },
    },
    { user: { id: 3 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) }
  );
  assert.equal(result.code, 'at_capacity');
  assert.match(result.message, /5 PRs up for vote/, 'the browser’s own wording');
  assert.equal(createdPr, false, 'a refused submit leaves no stray pull request behind');
});

test('a branch still at the base commit is named precisely, not left to GitHub', async () => {
  const gh = baseGh({ findOpenPrByBranch: async () => null, createPR: async () => ({ number: 1 }) });
  const empty = await withFetch({
    'GET /repos/someuser/recipe-box/branches/usernode%2Frecipe-box-issue-4-abc123': {
      status: 200, body: { commit: { sha: TASK_ROW.base_sha } },
    },
  }, [], () => svc.submitWork(
    { pool: submitPool([]), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    { user: { id: 3 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) }
  ));
  assert.equal(empty.code, 'no_commits');
  assert.equal(empty.retryable, true);
});

test('the pre-push check is advisory: a fork under another name still submits', async () => {
  // The agent may have forked under a name we did not predict, so our public
  // read of the expected fork 404s while the branch exists perfectly well.
  // That must not refuse — GitHub's own answer to createPR is authoritative.
  const queries = [];
  let created = false;
  const gh = baseGh({
    findOpenPrByBranch: async () => null,
    createPR: async () => {
      created = true;
      return { number: 91, html_url: 'x', head: { repo: { owner: { login: 'someuser' } } } };
    },
  });
  const result = await withFetch({
    'GET /repos/someuser/recipe-box/branches/usernode%2Frecipe-box-issue-4-abc123': { status: 404, body: {} },
  }, [], () => svc.submitWork(
    { pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    { user: { id: 3 }, taskId: 31, importProposal: async () => ({ ok: true, status: 200, body: { sessionId: 61 } }) }
  ));
  assert.equal(created, true, 'GitHub gets the final word on whether the head exists');
  assert.equal(result.ok, true);
  assert.equal(result.prNumber, 91);
});

test('a head GitHub really cannot find is reported as the missing branch it is', async () => {
  // GitHub answers an unknown head with an UNTYPED 422 ("invalid field:
  // head"). Our own read already said the branch is not on the expected
  // fork, so say the useful thing rather than "could not be opened".
  const gh = baseGh({
    findOpenPrByBranch: async () => null,
    createPR: async () => {
      const err = new Error('Validation Failed');
      err.status = 422;
      throw err;
    },
  });
  const result = await withFetch({
    'GET /repos/someuser/recipe-box/branches/usernode%2Frecipe-box-issue-4-abc123': { status: 404, body: {} },
  }, [], () => svc.submitWork(
    { pool: submitPool([]), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    { user: { id: 3 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) }
  ));
  assert.equal(result.code, 'branch_not_found');
  assert.equal(result.retryable, true);
  assert.match(result.message, /someuser\/recipe-box/);
});

test('a task that is not the caller’s own is simply unknown', async () => {
  const queries = [];
  const result = await svc.submitWork(
    {
      pool: fakePool([['FROM external_agent_tasks t JOIN apps a', []]], queries),
      config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits,
    },
    { user: { id: 99 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) }
  );
  assert.equal(result.code, 'unknown_task');
  // Ownership is in the WHERE clause, not in a branch after the read.
  assert.match(SRC, /WHERE t\.id = \$1 AND t\.user_id = \$2 AND t\.status = 'open'/);
});

test('a platform refusal to import is passed back with the platform’s own answer', async () => {
  const queries = [];
  const gh = baseGh({
    findOpenPrByBranch: async () => ({
      number: 88, html_url: 'x', head: { repo: { owner: { login: 'someuser' } } },
    }),
  });
  const result = await withFetch(PUSHED_BRANCH, [], () => svc.submitWork(
    { pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, taskId: 31,
      importProposal: async () => ({ ok: false, status: 409, body: { error: 'That PR is already imported.' } }),
    }
  ));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'import_failed');
  assert.equal(result.platformResult.status, 409);
  assert.match(result.message, /already imported/);
  // The task stays open so the user can retry once the conflict is cleared.
  assert.ok(!queries.some((q) => q.sql.includes('UPDATE external_agent_tasks')));
});

// ── Structural guarantees ──────────────────────────────────────────────

test('NO user credential is used, and every direct GitHub call is a public read', () => {
  // The load-bearing property of the identity-only link. A re-introduced
  // user-token header here would mean the OAuth scope has to widen back to
  // `public_repo` — read/write access to code in every public repository the
  // user can reach — which is exactly what this design removed.
  assert.doesNotMatch(SRC, /authorization:\s*`Bearer \$\{(token|link\.token|userToken)/);
  assert.doesNotMatch(SRC, /loadUserToken/);
  assert.doesNotMatch(SRC, /githubAsUser/);
  // github-link exposes no token loader to call, either.
  const LINK_SRC = fs.readFileSync(
    path.join(__dirname, '../src/services/github-link.js'), 'utf8'
  );
  assert.doesNotMatch(LINK_SRC, /async function loadUserToken/);

  // Direct fetches go through ONE helper, which builds its headers from the
  // platform's own public-read builder and never takes a credential.
  const helper = SRC.slice(
    SRC.indexOf('async function githubPublic'),
    SRC.indexOf('function sameRepo')
  );
  assert.match(helper, /githubService\.publicApiHeaders\(\)/);
  assert.doesNotMatch(helper, /authorization/i);
  const calls = [...SRC.matchAll(/githubPublic\(\s*\n?\s*'(\w+)'/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, 'the fork read and the branch read');
  for (const method of calls) {
    assert.equal(method, 'GET', 'nothing this service sends directly is a write');
  }
  // No fork/ref/merge-upstream write anywhere.
  assert.doesNotMatch(SRC, /\/forks`/);
  assert.doesNotMatch(SRC, /merge-upstream/);
  assert.doesNotMatch(SRC, /git\/refs/);
});

test('the service never opens a proposal itself', () => {
  // Creating the chat_sessions row, the staging preview, the checks and the
  // vote is the import route's job — reached over loopback with the
  // caller's own token. Reimplementing any of it here would route around
  // the authorization the browser goes through.
  assert.doesNotMatch(SRC, /INSERT INTO chat_sessions/);
  assert.doesNotMatch(SRC, /INSERT INTO pr_votes/);
  assert.match(SRC, /await importProposal\(slug, pr\.number\)/);
});

// ── The PR-creation ladder ─────────────────────────────────────────────
//
// The reason this whole area was rewritten. `submit_work` had never once
// succeeded in production: every attempt reached `platform_error: The pull
// request could not be opened`, an error that discarded whatever GitHub
// actually said. There are three rungs now — the plain cross-fork create,
// the same call with an explicit head_repo, and a mirror into the app's own
// repository — and the error that survives all three names the cause.

const logger = require('../src/services/logger');

// A gh stub carrying the two diagnostics helpers the real service module
// exposes, so the failure-logging assertions see what production would.
function ghWithDiagnostics(overrides = {}) {
  return baseGh({
    describeGithubError: require('../src/services/github').describeGithubError,
    credentialClass: () => (process.env.GITHUB_BOT_TOKEN ? 'pat' : 'installation'),
    ...overrides,
  });
}

// A GitHub 422 shaped exactly like the one `POST /pulls` returns for a head
// it will not accept, headers and all.
function validationFailed({ scopes = 'repo, workflow', errors } = {}) {
  const err = new Error('Validation Failed');
  err.status = 422;
  err.response = {
    status: 422,
    headers: {
      'x-github-request-id': 'ABCD:1234:5678',
      'x-oauth-scopes': scopes,
    },
    data: {
      message: 'Validation Failed',
      errors: errors || [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
    },
  };
  return err;
}

test('a 4xx cross-fork create is retried ONCE with an explicit head_repo', async () => {
  // The leading hypothesis, tested for the cost of one request: a bare
  // `owner:branch` head makes GitHub search the base's fork network, which
  // is ambiguous whenever the user owns two repos in it.
  const queries = [];
  const attempts = [];
  let mirrored = false;
  const gh = ghWithDiagnostics({
    findOpenPrByBranch: async () => null,
    createPR: async (owner, repo, opts) => {
      attempts.push(opts);
      if (!opts.headRepo) throw validationFailed();
      return { number: 92, html_url: 'x', head: { repo: { owner: { login: 'someuser' } } } };
    },
  });

  const result = await withFetch(PUSHED_BRANCH, [], () => svc.submitWork(
    { pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, taskId: 31, source: 'work_order',
      importProposal: async () => ({ ok: true, status: 200, body: { sessionId: 71 } }),
    }
  ));

  assert.equal(result.ok, true);
  assert.equal(result.prNumber, 92);
  assert.equal(result.submittedVia, 'branch_head_repo');
  assert.equal(attempts.length, 2, 'exactly one retry, never a loop');
  assert.equal(attempts[0].headRepo, undefined, 'the plain cross-fork shape is still preferred');
  assert.equal(attempts[1].headRepo, 'someuser/recipe-box');
  assert.equal(attempts[1].head, 'someuser:usernode/recipe-box-issue-4-abc123',
    'head is unchanged — head_repo only disambiguates it');
  assert.equal(mirrored, false, 'a working retry never reaches the mirror');

  // Recorded so "was the missing head_repo the whole bug?" is a SQL query
  // rather than another production audit.
  const close = queries.find((q) => q.sql.includes('UPDATE external_agent_tasks'));
  assert.match(close.sql, /submitted_via/);
  assert.ok(close.params.includes('branch_head_repo'));
  assert.ok(close.params.includes('work_order'));
});

test('a PR-open failure is never opaque again — it names status, field and a way out', async () => {
  const gh = ghWithDiagnostics({
    findOpenPrByBranch: async () => null,
    // Refuses identically with and without head_repo, so the mirror is the
    // only rung left — and here it is unavailable, exercising the error.
    createPR: async () => { throw validationFailed(); },
    compareCommitAncestry: async () => { throw new Error('offline'); },
  });

  const result = await withFetch({
    ...PUSHED_BRANCH,
    'GET /repos/someuser/recipe-box': {
      status: 200,
      body: { fork: true, name: 'recipe-box', owner: { login: 'someuser' } },
    },
  }, [], () => svc.submitWork(
    { pool: submitPool([]), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    { user: { id: 3 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) }
  ));

  assert.equal(result.code, 'pr_open_failed');
  // GitHub's own answer, not ours: the status, the field it objected to,
  // and a reference id anybody can quote at GitHub support.
  assert.match(result.message, /HTTP 422/);
  assert.match(result.message, /head/);
  assert.match(result.message, /invalid/);
  assert.match(result.message, /ABCD:1234:5678/);
  assert.equal(result.githubStatus, 422);
  assert.equal(result.requestId, 'ABCD:1234:5678');
  // And the recovery, supplied rather than left to be hand-built — the
  // production agent constructed this URL itself, from the description.
  assert.match(result.compareUrl, /^https:\/\/github\.com\/usernode-bot\/recipe-box\/compare\/main\.\.\./);
  assert.match(result.compareUrl, /someuser:recipe-box:usernode\/recipe-box-issue-4-abc123\?expand=1/);
  assert.match(result.message, /submit_work again with/);
  assert.match(result.message, /prNumber/);
  // Two identical attempts minutes apart proved retrying is not the answer.
  assert.notEqual(result.retryable, true);

  // The string that cost a production run is gone from the module.
  assert.doesNotMatch(SRC, /The pull request could not be opened/);
  assert.doesNotMatch(SRC, /'platform_error'/);
});

test('a failed create logs the diagnosis — status, request id, credential, scopes — and no token', async () => {
  const realToken = process.env.GITHUB_BOT_TOKEN;
  process.env.GITHUB_BOT_TOKEN = 'ghp_testtokenvaluethatmustnotbelogged00';
  try {
    const gh = ghWithDiagnostics({
      findOpenPrByBranch: async () => null,
      createPR: async () => { throw validationFailed({ scopes: 'repo, read:org' }); },
      compareCommitAncestry: async () => { throw new Error('offline'); },
    });
    await withFetch({
      ...PUSHED_BRANCH,
      'GET /repos/someuser/recipe-box': {
        status: 200, body: { fork: true, name: 'recipe-box', owner: { login: 'someuser' } },
      },
    }, [], () => svc.submitWork(
      { pool: submitPool([]), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
      { user: { id: 3 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) }
    ));

    const entry = logger.tail(40).find((e) => /PR creation failed on both attempts/.test(e.message));
    assert.ok(entry, 'the failure is logged at all');
    assert.equal(entry.data.status, 422);
    assert.equal(entry.data.requestId, 'ABCD:1234:5678');
    assert.equal(entry.data.credential, 'pat');
    // The header STRING — the one fact that turns "what can this token do?"
    // from an argument into a fact, and the piece whose absence forced a
    // production audit to even frame the question.
    assert.equal(entry.data.oauthScopes, 'repo, read:org');
    assert.equal(entry.data.headRepoSent, 'someuser/recipe-box');

    // Never the token itself, on any path.
    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes('testtokenvaluethatmustnotbelogged'),
      'no part of the bot token reaches a log payload');
  } finally {
    if (realToken === undefined) delete process.env.GITHUB_BOT_TOKEN;
    else process.env.GITHUB_BOT_TOKEN = realToken;
  }
});

test('describeGithubError carries the scope header and never invents one', () => {
  const github = require('../src/services/github');
  const withHeaders = github.describeGithubError(validationFailed({ scopes: 'public_repo' }));
  assert.equal(withHeaders.scopes, 'public_repo');
  assert.equal(withHeaders.status, 422);
  // An App installation token has no scopes to report, and a bare Error has
  // no response at all — both must be null, never a guess.
  assert.equal(github.describeGithubError(new Error('boom')).scopes, null);
  assert.equal(github.describeGithubError(null).scopes, null);
});

// ── The untrusted envelope ─────────────────────────────────────────────

test('the <untrusted-content> envelope never reaches GitHub, but stays in the work order', async () => {
  const created = [];
  const gh = baseGh({
    findOpenPrByBranch: async () => null,
    createPR: async (owner, repo, opts) => {
      created.push(opts);
      return { number: 93, html_url: 'x', head: { repo: { owner: { login: 'someuser' } } } };
    },
  });
  const wrapped = {
    ...TASK_ROW,
    brief: '<untrusted-content>Add autocomplete to username invites</untrusted-content>',
  };
  const pool = fakePool([
    ['FROM external_agent_tasks t JOIN apps a', [wrapped]],
    ['UPDATE chat_sessions SET external_agent', []],
    ['UPDATE external_agent_tasks', []],
  ], []);

  await withFetch(PUSHED_BRANCH, [], () => svc.submitWork(
    { pool, config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, taskId: 31,
      body: '<untrusted-content>and validate they exist</untrusted-content>',
      importProposal: async () => ({ ok: true, status: 200, body: { sessionId: 72 } }),
    }
  ));

  // Production's task 3 would otherwise have put a proposal literally
  // titled "<untrusted-content>Add autocomplete…</untrusted-content>" to a
  // group vote.
  assert.equal(created[0].title, 'Add autocomplete to username invites');
  assert.doesNotMatch(created[0].title, /untrusted-content/);
  assert.doesNotMatch(created[0].body, /untrusted-content/);
  assert.equal(created[0].body, 'and validate they exist');

  // But the envelope keeps doing its job where it matters: the work order
  // goes to a second agent that has a shell.
  const order = orderFor('ready');
  assert.match(order, /<untrusted-content>Add dark mode<\/untrusted-content>/);
});

test('stripEnvelope removes the marker and nothing else', () => {
  assert.equal(svc.stripEnvelope('<untrusted-content>hi</untrusted-content>'), 'hi');
  assert.equal(svc.stripEnvelope('<UNTRUSTED-CONTENT>hi</UNTRUSTED-CONTENT>'), 'hi');
  assert.equal(svc.stripEnvelope('a <untrusted-content>b</untrusted-content> c'), 'a b c');
  // Not an HTML stripper — only this one marker goes.
  assert.equal(svc.stripEnvelope('<b>keep</b>'), '<b>keep</b>');
  assert.equal(svc.stripEnvelope(null), '');
});

// ── The mirror fallback ────────────────────────────────────────────────

const FORK_AND_BRANCH = {
  'GET /repos/someuser/recipe-box': {
    status: 200,
    body: { fork: true, name: 'recipe-box', owner: { login: 'someuser' } },
  },
  'GET /repos/someuser/recipe-box/branches/usernode%2Frecipe-box-issue-4-abc123': {
    status: 200, body: { commit: { sha: '89abcdef0123456789abcdef0123456789abcdef' } },
  },
};

test('the mirror verifies provenance BEFORE copying, and refuses another account’s fork', async () => {
  const headSvc = require('../src/services/external-agent-head');
  const seen = [];
  const publicRead = async (method, p) => {
    seen.push(`${method} ${p}`);
    return { ok: true, status: 200, body: { owner: { login: 'attacker' } } };
  };
  const refused = await headSvc.verifyForkBranch({
    githubPublic: publicRead,
    forkOwner: 'attacker', forkRepo: 'recipe-box',
    branch: 'feat/x', expectedLogin: 'someuser',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'fork_mismatch');
  // Refused on the NAME before a single GitHub read: the gate is cheap and
  // it is the load-bearing security property of this whole path.
  assert.equal(seen.length, 0);

  // A hostile ref never reaches git.
  for (const bad of ['../../etc', 'a@{1}', '-x', 'a//b', '/lead', 'trail/']) {
    const r = await headSvc.verifyForkBranch({
      githubPublic: publicRead, forkOwner: 'someuser', forkRepo: 'recipe-box',
      branch: bad, expectedLogin: 'someuser',
    });
    assert.equal(r.code, 'invalid_request', `refused: ${bad}`);
  }
});

test('the mirror also refuses when GitHub says the repo belongs to someone else', async () => {
  const headSvc = require('../src/services/external-agent-head');
  // The caller names their OWN login, but GitHub reports a different owner
  // for that repository — the name is the caller's claim, GitHub's answer
  // is the fact.
  const result = await headSvc.verifyForkBranch({
    githubPublic: async () => ({ ok: true, status: 200, body: { owner: { login: 'someone-else' } } }),
    forkOwner: 'someuser', forkRepo: 'recipe-box',
    branch: 'feat/x', expectedLogin: 'someuser',
  });
  assert.equal(result.code, 'fork_mismatch');
});

test('a branch that is not built on the recorded base is refused, not mirrored', async () => {
  // A mirror writes into the APP's repository with the platform's own
  // credentials — a stronger action than a cross-fork PR, so "is this
  // actually built on the work we handed out?" has to be answered.
  const gh = ghWithDiagnostics({
    findOpenPrByBranch: async () => null,
    createPR: async () => { throw validationFailed(); },
    compareCommitAncestry: async () => ({ status: 'diverged', behindBy: 40 }),
  });
  const result = await withFetch(FORK_AND_BRANCH, [], () => svc.submitWork(
    { pool: submitPool([]), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    { user: { id: 3 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) }
  ));
  assert.equal(result.code, 'base_mismatch');
  assert.match(result.message, new RegExp(TASK_ROW.base_sha));
});

test('a mirror the platform wrote skips the PR-level owner check — a named PR never does', async () => {
  // The gate is RELOCATED, not dropped: a mirrored head is owned by the
  // bot, so comparing its owner to the linked login would pass vacuously.
  // Provenance is proven before the copy instead.
  assert.match(SRC, /if \(!platformOwnedHead\) \{/);
  assert.match(SRC, /const mismatch = attributionError\(pr, link\.login\);/);
  // platformOwnedHead is only ever set on the two paths that WRITE a head.
  const assignments = [...SRC.matchAll(/platformOwnedHead = (\w+);/g)]
    .map((m) => m[1]).filter((n) => n !== 'null');
  assert.deepEqual(assignments.sort(), ['applied', 'mirrored']);
  // A caller-named prNumber takes the `pr` branch, which never assigns it.
  const prBranch = SRC.slice(SRC.indexOf('if (prNumber) {'), SRC.indexOf("via = 'pr';"));
  assert.doesNotMatch(prBranch, /platformOwnedHead =/);
});

test('the mirror and patch helpers prefer the bot PAT and only then an installation token', async () => {
  // Not cosmetic: conflict-resolver records that the installation path
  // THROWS for the self-app's owner, which has no installation at all. An
  // installation-first helper would break on the platform's own app and
  // nowhere else.
  const headSvc = require('../src/services/external-agent-head');
  const github = require('../src/services/github');
  const realToken = process.env.GITHUB_BOT_TOKEN;
  const realInstall = github.getInstallationToken;
  let installationCalls = 0;
  github.getInstallationToken = async () => { installationCalls += 1; return 'ghs_installationtoken'; };
  try {
    process.env.GITHUB_BOT_TOKEN = 'ghp_thepat';
    const withPat = await headSvc.resolveWriteCredential('usernode-bot');
    assert.equal(withPat.source, 'pat');
    assert.equal(withPat.token, 'ghp_thepat');
    assert.equal(installationCalls, 0, 'the installation path is not even consulted');

    delete process.env.GITHUB_BOT_TOKEN;
    const withApp = await headSvc.resolveWriteCredential('usernode-bot');
    assert.equal(withApp.source, 'installation');
    assert.equal(installationCalls, 1);
  } finally {
    github.getInstallationToken = realInstall;
    if (realToken === undefined) delete process.env.GITHUB_BOT_TOKEN;
    else process.env.GITHUB_BOT_TOKEN = realToken;
  }
});

test('a git failure never leaks the bot token into a log', () => {
  const headSvc = require('../src/services/external-agent-head');
  const token = 'ghp_secretvalue';
  const message = `fatal: could not read from https://x-access-token:${token}@github.com/o/r.git`;
  const safe = headSvc.redactToken(message, token);
  assert.ok(!safe.includes(token));
  assert.match(safe, /\*\*\*/);
  // The credential only ever appears inside a remote URL built here.
  const HEAD_SRC = fs.readFileSync(
    path.join(__dirname, '../src/services/external-agent-head.js'), 'utf8'
  );
  assert.match(HEAD_SRC, /function authenticatedRemote/);
  // Every git failure this file logs is redacted first: git puts the whole
  // remote URL — token included — in its error text.
  for (const src of [HEAD_SRC, fs.readFileSync(
    path.join(__dirname, '../src/services/external-agent-patch.js'), 'utf8'
  )]) {
    for (const [, arg] of src.matchAll(/err: ([^,\n]+)/g)) {
      assert.match(arg, /redactToken|err\.message \}\)|err && err\.message/,
        `a logged error must be redacted: ${arg}`);
    }
    // And the token value itself only ever reaches three places: the
    // remote URL builder, the redactor, and deleteBranch's own parameter.
    for (const [, context] of src.matchAll(/(\w+)\(([^()]*credential\.token[^()]*)\)/g)) {
      assert.ok(['authenticatedRemote', 'redactToken', 'deleteBranch'].includes(context),
        `unexpected use of the token: ${context}`);
    }
  }
});

// ── The patch path ─────────────────────────────────────────────────────

test('a patch is refused before ANY git write when it touches CI', () => {
  const patchSvc = require('../src/services/external-agent-patch');
  assert.equal(patchSvc.forbiddenPath('.github/workflows/deploy.yml'), true);
  assert.equal(patchSvc.forbiddenPath('.github'), true);
  assert.equal(patchSvc.forbiddenPath('../outside'), true);
  assert.equal(patchSvc.forbiddenPath('/etc/passwd'), true);
  assert.equal(patchSvc.forbiddenPath('src/server.js'), false);
  assert.equal(patchSvc.forbiddenPath('public/.github-icon.png'), false);

  // A rename form names BOTH sides, so neither can smuggle a CI edit.
  const renamed = patchSvc.parseNumstat('1\t1\t{src/a.js => .github/b.yml}\n');
  assert.ok(renamed.some(patchSvc.forbiddenPath), 'both sides of a rename are checked');
  // A binary file prints `-` counts and must still be enumerated.
  assert.deepEqual(patchSvc.parseNumstat('-\t-\tpublic/img.png\n'), ['public/img.png']);
});

test('an over-sized patch is refused before a single GitHub call', async () => {
  const patchSvc = require('../src/services/external-agent-patch');
  let touched = false;
  const github = require('../src/services/github');
  const realInstall = github.getInstallationToken;
  github.getInstallationToken = async () => { touched = true; return 't'; };
  try {
    const result = await patchSvc.applyPatch({
      owner: 'usernode-bot', repo: 'recipe-box',
      patch: 'x'.repeat(patchSvc.MAX_PATCH_BYTES + 1),
      baseSha: TASK_ROW.base_sha, userId: 3, taskId: 31,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'patch_too_large');
    assert.equal(result.retryable, false);
    // And it names the route that has no size limit rather than dead-ending.
    assert.match(result.message, /branch/);
    assert.equal(touched, false, 'the credential is not even resolved');
  } finally {
    github.getInstallationToken = realInstall;
  }
});

test('an empty patch and a patch with no base commit are both refused up front', async () => {
  const patchSvc = require('../src/services/external-agent-patch');
  const empty = await patchSvc.applyPatch({
    owner: 'o', repo: 'r', patch: '   ', baseSha: TASK_ROW.base_sha, userId: 3, taskId: 1,
  });
  assert.equal(empty.code, 'invalid_request');
  const noBase = await patchSvc.applyPatch({
    owner: 'o', repo: 'r', patch: 'diff --git a/x b/x', baseSha: null, userId: 3, taskId: 1,
  });
  assert.equal(noBase.code, 'invalid_request');
});

test('a format-patch mbox is told apart from a plain diff', () => {
  const patchSvc = require('../src/services/external-agent-patch');
  assert.equal(
    patchSvc.isMbox(`From ${'a'.repeat(40)} Mon Sep 17 00:00:00 2001\nFrom: x\n`), true
  );
  assert.equal(patchSvc.isMbox('diff --git a/x b/x\n'), false);
  assert.equal(patchSvc.isMbox(''), false);
});

test('a patch without a taskId is refused — there is no commit to apply it at', async () => {
  const result = await svc.submitWork(
    { pool: fakePool([], []), config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, slug: 'recipe-box', patch: 'diff --git a/x b/x',
      repoUrl: 'https://github.com/usernode-bot/recipe-box',
      importProposal: async () => ({ ok: true, body: {} }),
    }
  );
  assert.equal(result.code, 'invalid_request');
  assert.match(result.message, /taskId/);
});

test('the caps run BEFORE a patch is applied, so a refusal leaves no branch', async () => {
  // Same guarantee the branch path has always had, extended to the path
  // that writes a commit with the platform's own credentials.
  const capIndex = SRC.indexOf('checkPromotedCap');
  const patchIndex = SRC.indexOf('externalAgentPatch.applyPatch');
  assert.ok(capIndex > 0 && patchIndex > 0);
  assert.ok(capIndex < patchIndex, 'the promoted-session cap is checked first');
  assert.ok(SRC.indexOf('checkProposalRate') < patchIndex, 'and so is the proposal rate');
});

// ── Two callers, one task ──────────────────────────────────────────────

test('a second submit of finished work returns the proposal, not "start again"', async () => {
  // The coding agent submits for itself now, so the user may ALSO tell
  // their chat assistant it is done. The old answer ("that work does not
  // exist… start again with prepare_work") would have opened a duplicate
  // for work already up for a vote.
  const queries = [];
  const pool = fakePool([
    ['LEFT JOIN chat_sessions', [{
      ...TASK_ROW, status: 'submitted', session_id: 55, proposal_id: 55,
    }]],
    ["t.status = 'open'", []],
  ], queries);

  let imported = false;
  const result = await svc.submitWork(
    { pool, config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, taskId: 31,
      importProposal: async () => { imported = true; return { ok: true, body: {} }; },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.code, 'already_submitted');
  assert.equal(result.alreadySubmitted, true);
  assert.equal(result.proposalId, 55);
  assert.equal(result.appSlug, 'recipe-box');
  assert.match(result.message, /already submitted/i);
  assert.equal(imported, false, 'nothing is imported a second time');
  assert.ok(!queries.some((q) => /UPDATE/.test(q.sql)), 'and nothing is written');
});

test('a task belonging to somebody else is still refused, and says why plainly', async () => {
  const pool = fakePool([
    ['LEFT JOIN chat_sessions', []],
    ["t.status = 'open'", []],
  ], []);
  const result = await svc.submitWork(
    { pool, config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits },
    { user: { id: 99 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) }
  );
  assert.equal(result.code, 'unknown_task');
  // The old message told the agent to start over, which burns a slot. The
  // new one names the actual cause — a connector signed in as somebody else.
  assert.doesNotMatch(result.message, /Start again with prepare_work/);
  assert.match(result.message, /USERNODE ACCOUNT|signed in as somebody else/);
});

test('concurrent submits are serialized on the task, so one piece of work is one PR', async () => {
  // A session-scoped advisory lock keyed on the task id: the second caller
  // blocks, then re-reads the task and finds it submitted.
  assert.match(SRC, /pg_advisory_lock\(\$1, \$2\)/);
  assert.match(SRC, /pg_advisory_unlock\(\$1, \$2\)/);
  assert.match(SRC, /EXTERNAL_TASK_SUBMIT_LOCK/);
  const locks = require('../src/services/advisory-locks');
  assert.equal(typeof locks.EXTERNAL_TASK_SUBMIT_LOCK, 'number');
  assert.notEqual(locks.EXTERNAL_TASK_SUBMIT_LOCK, locks.ADMIN_MUTATION_LOCK,
    'two locks that mean different things must not collide');

  // The lock is released on the failure path too, or one bad submit wedges
  // every later one for that task.
  const lockFn = SRC.slice(SRC.indexOf('async function withTaskLock'), SRC.indexOf('// The caller\'s most recent open task'));
  assert.match(lockFn, /finally \{/);
  assert.match(lockFn, /client\.release\(\)/);

  // Two real concurrent calls: the first opens the PR, the second finds it
  // closed and returns the same proposal rather than opening a second one.
  let status = 'open';
  const created = [];
  // A fake that BLOCKS the way pg_advisory_lock does — without it the test
  // proves nothing, because two unblocked callers would both read 'open'
  // and both create a pull request, which is exactly the bug.
  let held = Promise.resolve();
  const pool = {
    connect: async () => {
      let release;
      const waitFor = held;
      held = new Promise((r) => { release = r; });
      return {
        async query(sql) {
          if (/pg_advisory_lock/.test(sql)) await waitFor;
          if (/pg_advisory_unlock/.test(sql)) release();
          return { rows: [] };
        },
        release: () => release(),
      };
    },
    async query(sql, params) {
      if (/WHERE t\.id = \$1 AND t\.user_id = \$2 AND t\.status = 'open'/.test(sql)) {
        return { rows: status === 'open' ? [TASK_ROW] : [] };
      }
      if (/LEFT JOIN chat_sessions/.test(sql)) {
        return { rows: [{ ...TASK_ROW, status, session_id: 81, proposal_id: 81 }] };
      }
      if (/UPDATE external_agent_tasks/.test(sql)) { status = 'submitted'; return { rows: [] }; }
      return { rows: [] };
    },
  };
  const gh = baseGh({
    findOpenPrByBranch: async () => null,
    createPR: async () => {
      created.push(1);
      return { number: 94, html_url: 'x', head: { repo: { owner: { login: 'someuser' } } } };
    },
  });
  const call = () => svc.submitWork(
    { pool, config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    { user: { id: 3 }, taskId: 31, importProposal: async () => ({ ok: true, body: { sessionId: 81 } }) }
  );
  const [first, second] = await withFetch(PUSHED_BRANCH, [], () => Promise.all([call(), call()]));
  assert.equal(created.length, 1, 'exactly one pull request for one piece of work');
  assert.ok(first.ok && second.ok);
  assert.ok(first.alreadySubmitted || second.alreadySubmitted,
    'the loser is told it is already submitted, not that the work vanished');
});

// ── Cross-client ownership ─────────────────────────────────────────────

test('a task recorded by one client is submittable by another for the SAME user', async () => {
  // The property the connector-first hand-off rests on, and the one a
  // production run guessed wrong about and stopped over: ownership is
  // per USERNODE ACCOUNT, never per chat and never per OAuth client.
  const queries = [];
  const gh = baseGh({
    findOpenPrByBranch: async () => null,
    createPR: async () => ({ number: 95, html_url: 'x', head: { repo: { owner: { login: 'someuser' } } } }),
  });
  const result = await withFetch(PUSHED_BRANCH, [], () => svc.submitWork(
    { pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 },
      // The task row was written by the chat assistant; this call is the
      // coding agent, a different client entirely.
      clientId: 'svmc_codingagent', clientName: 'Claude Code',
      taskId: 31, source: 'work_order',
      importProposal: async () => ({ ok: true, body: { sessionId: 82 } }),
    }
  ));
  assert.equal(result.ok, true);
  assert.equal(result.prNumber, 95);

  // Ownership is in the WHERE clause and has no client predicate.
  const load = SRC.slice(SRC.indexOf('async function loadOpenTask'), SRC.indexOf('// The caller\'s task in ANY status'));
  assert.doesNotMatch(load, /client_id/);
});

// ── Idempotency ────────────────────────────────────────────────────────

// A pool that behaves like the real table for prepare_work: it remembers
// the rows it inserted and honours the partial unique index on
// (user, app, request_key) WHERE status='open'.
function idempotentPool(queries) {
  const rows = [];
  let nextId = 100;
  return {
    rows,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('SELECT * FROM external_agent_tasks')) {
        const [userId, appId, key] = params;
        const hit = rows.find((r) => r.user_id === userId && r.app_id === appId
          && r.request_key === key && r.status === 'open');
        return { rows: hit ? [hit] : [] };
      }
      if (sql.includes('INSERT INTO external_agent_tasks')) {
        const [user_id, app_id, issue_number, fork_owner, fork_repo,
          branch_name, base_sha, brief, client_id, request_key] = params;
        const clash = rows.some((r) => r.user_id === user_id && r.app_id === app_id
          && r.request_key === request_key && r.status === 'open');
        if (clash) return { rows: [] };            // ON CONFLICT DO NOTHING
        const row = {
          id: nextId++, user_id, app_id, issue_number, fork_owner, fork_repo,
          branch_name, base_sha, brief, client_id, request_key, status: 'open',
        };
        rows.push(row);
        return { rows: [row] };
      }
      if (sql.includes("SET status = 'abandoned'")) {
        for (const r of rows) {
          if (r.user_id === params[0] && r.app_id === params[1]
            && r.request_key === params[2] && r.status === 'open') r.status = 'abandoned';
        }
        return { rows: [] };
      }
      throw new Error(`unstubbed query: ${sql.slice(0, 60)}`);
    },
  };
}

function prepareTwice(params, { pool, limits }) {
  return withFetch(FORK_READY, [], () => svc.prepareWork(
    { pool, config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits },
    { user: { id: 3 }, app: APP, origin: 'https://usernode.example', ...params }
  ));
}

test('asking twice for the same request returns the SAME job, and spends no allowance', async () => {
  // Three OPEN rows for one request is what production actually recorded —
  // each with a different branch, each burning a slot, and the agent then
  // rewrote its finished commit to match the newest name.
  const queries = [];
  const pool = idempotentPool(queries);
  let prepareChecks = 0;
  const limits = { ...okLimits, checkPrepareRate: async () => { prepareChecks += 1; return null; } };

  const first = await prepareTwice({ issueNumber: 4, brief: 'x' }, { pool, limits });
  const second = await prepareTwice({ issueNumber: 4, brief: 'x' }, { pool, limits });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.taskId, first.taskId, 'the same job');
  assert.equal(second.branch, first.branch, 'the same branch — never a new name to chase');
  assert.equal(second.baseSha, first.baseSha, 'and the ORIGINAL base commit, not a re-read of main');
  assert.equal(second.reused, true);
  assert.equal(first.reused, false);
  assert.equal(pool.rows.length, 1, 'exactly one row exists');
  assert.equal(prepareChecks, 1, 're-rendering a work order the caller already has costs nothing');
});

test('idempotency keys on the request: same brief reuses, a different brief does not', async () => {
  const pool = idempotentPool([]);
  const a = await prepareTwice({ brief: 'add dark mode' }, { pool, limits: okLimits });
  const b = await prepareTwice({ brief: 'add dark mode' }, { pool, limits: okLimits });
  const c = await prepareTwice({ brief: 'add light mode' }, { pool, limits: okLimits });
  assert.equal(b.taskId, a.taskId, 'a byte-identical brief is the same request');
  assert.notEqual(c.taskId, a.taskId, 'a different brief is different work');
  assert.equal(pool.rows.length, 2);

  // The key itself, and the shape src/db/schema.sql backfills.
  assert.equal(svc.requestKeyFor(50, 'anything'), 'issue:50');
  assert.match(svc.requestKeyFor(null, 'add dark mode'), /^brief:[0-9a-f]{32}$/);
  assert.equal(svc.requestKeyFor(null, 'a'), svc.requestKeyFor(null, 'a'));
  assert.notEqual(svc.requestKeyFor(null, 'a'), svc.requestKeyFor(null, 'b'));
  // An issue number wins over the brief, so editing the wording of a
  // request does not fork the job.
  assert.equal(svc.requestKeyFor(7, 'one'), svc.requestKeyFor(7, 'two'));
});

test('restart: true closes the old job out and mints exactly one new one', async () => {
  const queries = [];
  const pool = idempotentPool(queries);
  const first = await prepareTwice({ issueNumber: 4, brief: 'x' }, { pool, limits: okLimits });
  const restarted = await prepareTwice({ issueNumber: 4, brief: 'x', restart: true }, { pool, limits: okLimits });

  assert.notEqual(restarted.taskId, first.taskId);
  assert.equal(restarted.reused, false);
  assert.equal(pool.rows.length, 2, 'one new row, not two');
  // The old one is CLOSED, not left dangling against the open-task bound.
  assert.equal(pool.rows.find((r) => r.id === first.taskId).status, 'abandoned');
  assert.equal(pool.rows.find((r) => r.id === restarted.taskId).status, 'open');
  assert.ok(queries.some((q) => q.sql.includes("SET status = 'abandoned'")));
});

test('a race on the same request resolves to one row, and the loser is served it', async () => {
  const pool = idempotentPool([]);
  const [a, b] = await Promise.all([
    prepareTwice({ issueNumber: 9, brief: 'x' }, { pool, limits: okLimits }),
    prepareTwice({ issueNumber: 9, brief: 'x' }, { pool, limits: okLimits }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.taskId, b.taskId, 'ON CONFLICT DO NOTHING, then re-select');
  assert.equal(pool.rows.length, 1);
});

// ── The work order's new text ──────────────────────────────────────────

function fullOrder(overrides = {}) {
  return svc.buildWorkOrder({
    appName: 'Recipe Box', appSlug: 'recipe-box',
    upstreamUrl: 'https://github.com/usernode-bot/recipe-box',
    upstreamSlug: 'usernode-bot/recipe-box',
    forkUrl: 'https://github.com/someuser/recipe-box',
    forkCloneUrl: 'https://github.com/someuser/recipe-box.git',
    forkRepo: 'recipe-box',
    forkPageUrl: 'https://github.com/usernode-bot/recipe-box/fork',
    forkStatus: 'ready',
    branch: 'usernode/recipe-box-issue-4-abc123',
    baseSha: BASE_SHA,
    issueNumber: 4,
    brief: '<untrusted-content>Add dark mode</untrusted-content>',
    webPath: 'https://usernode.example/#app/recipe-box',
    taskId: 31,
    agentLabelText: 'claude-code',
    ...overrides,
  });
}

test('the work order names the task and says who it belongs to', async () => {
  const order = fullOrder();
  assert.match(order, /Usernode task id:\s+31/);
  assert.match(order, /Usernode app slug:\s+recipe-box/);
  // The exact sentence a production run needed and did not have: it had a
  // live connector, the right account and the taskId one call away, and
  // declined on a guess about who owned it.
  assert.match(order, /belongs to the USERNODE ACCOUNT/);
  assert.match(order, /Any Claude or ChatGPT session connected as that account/);
  assert.match(order, /including yours, can submit it/);
  assert.match(order, /unknown_task/);
  assert.match(order, /signed in as/);
  assert.match(order, /whoami/);
});

test('the work order forbids calling prepare_work again', async () => {
  const order = fullOrder();
  assert.match(order, /DO NOT CALL prepare_work/);
  assert.match(order, /mints a SECOND job/);
  assert.match(order, /does not obtain push access/);
  // And the trap that made one run rewrite a finished commit is gone.
  assert.doesNotMatch(order, /exactly as named above/);
  assert.match(order, /Suggested branch name/);
  assert.match(order, /any branch name is accepted/i);
  assert.match(order, /never a reason to rewrite, rebase or redo/);
});

test('the work order describes the push remedy accurately, and warns whose 403 it is', async () => {
  const order = fullOrder();
  assert.match(order, /https:\/\/github\.com\/apps\/claude/);
  assert.match(order, /\/web-setup/);
  assert.match(order, /A personal account can do this itself/);
  assert.match(order, /No organization admin is required/);
  assert.match(order, /takes effect in the RUNNING session/);
  assert.match(order, /per-repository "push access" toggle helps/);
  // The 403 two runs took literally came from Claude's own egress proxy,
  // not GitHub, and its documentation_url is how you tell.
  assert.match(order, /documentation_url/);
  assert.match(order, /Anthropic rather than GitHub/);
  assert.match(order, /egress proxy/);
  assert.match(order, /Do NOT relay it as/);
});

test('the work order presents every submit shape, in order of preference', async () => {
  const order = fullOrder();
  assert.match(order, /submit_work/);
  assert.match(order, /source "work_order"/);
  // The agent value is the one submit_work's enum accepts, not a label the
  // tool would have to coerce.
  assert.match(order, /agent "claude-code"/);
  assert.ok(svc.AGENTS.includes('claude-code'));
  assert.match(order, /pr_open_failed/);
  assert.match(order, /compareUrl/);
  assert.match(order, new RegExp(`git format-patch ${BASE_SHA}\\.\\.HEAD --stdout`));
  assert.match(order, /You do NOT need GitHub write access/i);
  assert.match(order, /insufficient_scope/);
  assert.match(order, /github_not_linked/);
  assert.match(order, /IF THE USERNODE TOOLS ARE NOT AVAILABLE/);
  // The push comes before the submit, and the patch after both.
  assert.ok(order.indexOf('git push -u origin HEAD') < order.indexOf('SUBMIT IT YOURSELF'));
  assert.ok(order.indexOf('SUBMIT IT YOURSELF') < order.indexOf('git format-patch'));
  // The connector reaches Usernode even though the sandbox cannot.
  assert.match(order, /connector traffic goes out through Claude's own infrastructure/);
});

test('the work order contains no triple-backtick fence and indents every command', async () => {
  // The host wraps the whole work order in a fence; an inner fence closes
  // it early. One production paste reached Claude Code with every fence
  // stripped and its commands flattened into prose.
  for (const status of ['ready', 'missing', 'name_conflict', 'unknown']) {
    const order = fullOrder({ forkStatus: status, platformRules: 'RULES BODY' });
    assert.ok(!order.includes('```'), `${status}: no fence anywhere`);
    for (const line of order.split('\n')) {
      if (/^\s*(git|gh) /.test(line)) {
        assert.match(line, /^ {4}(git|gh) /, `${status}: commands are indented: ${JSON.stringify(line)}`);
      }
    }
  }
});

test('a work order with no taskId keeps the old hand-back ending', async () => {
  // The connector-first tree only makes sense when the agent has something
  // to submit. Without a task id it reports the branch, as before.
  const order = fullOrder({ taskId: null });
  assert.doesNotMatch(order, /DO NOT CALL prepare_work/);
  assert.doesNotMatch(order, /SUBMIT IT YOURSELF/);
  assert.match(order, /Report the branch name you pushed/);
  assert.match(order, /Do not open a pull\n {3}request/);
});

test('the PLATFORM RULES appendix comes LAST, after everything load-bearing', async () => {
  const order = fullOrder({ platformRules: 'THE OFFLINE RULES' });
  assert.match(order, /PLATFORM RULES/);
  assert.match(order, /THE OFFLINE RULES/);
  // A host model that truncates should cost background guidance, never the
  // base commit, the push commands or the task id.
  const rulesAt = order.indexOf('PLATFORM RULES');
  for (const essential of [BASE_SHA, 'git push -u origin HEAD', 'Usernode task id', 'submit_work']) {
    assert.ok(order.indexOf(essential) < rulesAt, `${essential} survives a truncation`);
  }
  // And the hosted-asset warning sits immediately above it.
  for (const url of svc.HOSTED_ASSETS) assert.ok(order.includes(url), url);
  assert.match(order, /That\s+is your SANDBOX, not the change/i);
  assert.match(order, /rejected by two of the app's own automated/);
  assert.match(order, /staging preview Usernode builds/);
  assert.match(order, /https:\/\/usernode\.example\/claude\.md/);

  // Omitted entirely when there is nothing to append — never an empty heading.
  assert.doesNotMatch(fullOrder({ platformRules: '' }), /PLATFORM RULES/);
});

// ── unknown fork status ────────────────────────────────────────────────

const FORK_UNREADABLE = {};

test('an unreadable GitHub produces hedged wording, never "you have no fork"', async () => {
  const original = global.fetch;
  global.fetch = async () => { throw new Error('rate limited'); };
  let result;
  try {
    result = await svc.prepareWork(
      {
        pool: idempotentPool([]), config: {}, gh: baseGh(),
        githubLink: linkedAs('someuser'), limits: okLimits,
      },
      { user: { id: 3 }, app: APP, brief: 'x', origin: 'https://usernode.example' }
    );
  } finally {
    global.fetch = original;
  }

  assert.equal(result.ok, true);
  assert.equal(result.forkStatus, 'unknown', 'carried through, not collapsed into `missing`');
  // One run told a user to create a fork they already had. Both surfaces
  // hedge now.
  assert.match(result.guidance[0], /If you don't already have/);
  assert.match(result.guidance[0], /Skip this if you already have one/);
  assert.doesNotMatch(result.guidance.join('\n'), /the copy you just made/);
  assert.match(result.workOrder, /Usernode could not read GitHub just now/);
  assert.match(result.workOrder, /no-op if you do/);
  assert.doesNotMatch(result.workOrder, /you do not have one yet/);
});

// ── Tool metadata ──────────────────────────────────────────────────────

test('submit_work advertises every shape it accepts', () => {
  // Asserted against the module source, the way
  // tests/mcp-connector-policy.test.js pins the connector's own copy: an
  // affordance the model never reads is an affordance that does not exist.
  const TOOLS_SRC = fs.readFileSync(
    path.join(__dirname, '../src/services/mcp-tools.js'), 'utf8'
  );
  const block = TOOLS_SRC.slice(
    TOOLS_SRC.indexOf("registerTool('submit_work'"),
    TOOLS_SRC.indexOf("registerTool('start_platform_build'")
  );
  assert.match(block, /a pushed branch, a patch, or an open PR/);
  assert.match(block, /NO GitHub write access is needed/);
  assert.match(block, /THREE SHAPES/);
  assert.match(block, /prNumber/);
  assert.match(block, /USER'S USERNODE ACCOUNT/);
  assert.match(block, /not to one chat/);
  // The taskId description says where a coding agent actually gets it.
  assert.match(block, /printed in the work order/);
  // The no-identifier error enumerates the surface instead of naming one
  // shape — run two hit it and concluded "I have neither".
  assert.match(block, /Nothing to submit\. Any of these works/);
  assert.match(block, /slug \+ prNumber/);
  assert.match(block, /slug \+ branch/);
  assert.doesNotMatch(block, /'Pass the taskId returned by prepare_work\.'/);
});

test('the no-identifier refusal from the service enumerates the surface too', async () => {
  const result = await svc.submitWork(
    { pool: fakePool([], []), config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits },
    { user: { id: 3 }, importProposal: async () => ({ ok: true, body: {} }) }
  );
  assert.equal(result.code, 'invalid_request');
  for (const shape of ['taskId', 'patch', 'prNumber', 'slug + branch']) {
    assert.match(result.message, new RegExp(shape.replace(/\+/g, '\\+')));
  }
  assert.doesNotMatch(SRC, /'Pass the taskId returned by prepare_work\.'/);
});

// ── Caller-supplied branch and fork name ───────────────────────────────

test('a caller-supplied branch is validated, then used in place of the suggestion', async () => {
  const created = [];
  const probes = [];
  const gh = baseGh({
    findOpenPrByBranch: async (o, r, branch) => { probes.push(branch); return null; },
    createPR: async (o, r, opts) => {
      created.push(opts);
      return { number: 96, html_url: 'x', head: { repo: { owner: { login: 'someuser' } } } };
    },
  });
  const result = await withFetch({
    'GET /repos/someuser/recipe-box/branches/claude%2Fsomething-quuk2q': {
      status: 200, body: { commit: { sha: 'ffffffffffffffffffffffffffffffffffffffff' } },
    },
  }, [], () => svc.submitWork(
    { pool: submitPool([]), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, taskId: 31, branch: 'claude/something-quuk2q',
      importProposal: async () => ({ ok: true, body: { sessionId: 83 } }),
    }
  ));
  assert.equal(result.ok, true);
  assert.equal(probes[0], 'claude/something-quuk2q');
  assert.equal(created[0].head, 'someuser:claude/something-quuk2q');

  // A hostile ref never reaches git or GitHub.
  for (const bad of ['a b', 'x;rm -rf /', '--upload-pack=evil', 'a..b', 'a@{0}']) {
    const refused = await svc.submitWork(
      { pool: fakePool([], []), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
      { user: { id: 3 }, taskId: 31, branch: bad, importProposal: async () => ({ ok: true, body: {} }) }
    );
    assert.equal(refused.code, 'invalid_request', `refused: ${bad}`);
  }
});

test('the fork OWNER is always the linked login and is never taken from input', () => {
  // The anchor of the whole attribution gate. A caller may name a fork
  // REPOSITORY (agents fork under unexpected names) but never an owner.
  assert.match(SRC, /const forkOwner = task \? task\.fork_owner : link\.login;/);
  const submitBody = SRC.slice(SRC.indexOf('async function submitWorkLocked'), SRC.indexOf('function prTitleFor'));
  assert.doesNotMatch(submitBody, /params\.forkOwner/);
  assert.doesNotMatch(submitBody, /forkOwner = callerForkOwner/);
});

// ── The mirror, through submitWork ─────────────────────────────────────

// Swap the mirror helper for a stub, so the ladder can be exercised without
// git. The helper's own behaviour is covered by the tests above.
function withStubbedMirror(stub, fn) {
  const headSvc = require('../src/services/external-agent-head');
  const real = headSvc.mirrorForkBranch;
  headSvc.mirrorForkBranch = stub;
  return Promise.resolve(fn()).finally(() => { headSvc.mirrorForkBranch = real; });
}

test('when BOTH cross-fork attempts fail, the branch is mirrored and a same-repo PR opens', async () => {
  const queries = [];
  const created = [];
  let cleaned = false;
  const gh = ghWithDiagnostics({
    findOpenPrByBranch: async () => null,
    createPR: async (owner, repo, opts) => {
      created.push(opts);
      // Only the cross-fork shape is refused. The same-repo one — the shape
      // that demonstrably worked on this deployment the same afternoon the
      // connector failed — succeeds.
      if (opts.head) throw validationFailed();
      return { number: 97, html_url: 'x', head: { repo: { owner: { login: 'usernode-bot' } } } };
    },
  });

  const result = await withStubbedMirror(
    async (args) => {
      assert.equal(args.expectedLogin, 'someuser', 'provenance is checked against the LINKED login');
      assert.equal(args.baseSha, TASK_ROW.base_sha, 'and against the recorded base commit');
      return {
        ok: true,
        branch: 'usernode/from-someuser-t31-deadbeef',
        credential: 'pat',
        cleanup: async () => { cleaned = true; },
      };
    },
    () => withFetch(PUSHED_BRANCH, [], () => svc.submitWork(
      { pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
      {
        user: { id: 3 }, taskId: 31,
        importProposal: async () => ({ ok: true, status: 200, body: { sessionId: 84 } }),
      }
    ))
  );

  assert.equal(result.ok, true);
  assert.equal(result.prNumber, 97);
  assert.equal(result.submittedVia, 'mirror');
  assert.equal(cleaned, false, 'a successful submission keeps its branch');

  // Three createPR calls: cross-fork, cross-fork + head_repo, then same-repo.
  assert.equal(created.length, 3);
  assert.equal(created[0].headRepo, undefined);
  assert.equal(created[1].headRepo, 'someuser/recipe-box');
  assert.equal(created[2].head, undefined, 'the third is a PLAIN same-repo create');
  assert.equal(created[2].branch, 'usernode/from-someuser-t31-deadbeef');

  // A mirrored head is owned by the bot, so the PR-level owner check would
  // pass vacuously — it is skipped BECAUSE provenance was proven first.
  const close = queries.find((q) => q.sql.includes('UPDATE external_agent_tasks'));
  assert.ok(close.params.includes('mirror'));
  assert.ok(close.params.includes('usernode/from-someuser-t31-deadbeef'),
    'the branch actually submitted from is recorded');
});

test('a mirrored branch the platform cannot import is removed, not left on the app', async () => {
  let cleaned = false;
  const gh = ghWithDiagnostics({
    findOpenPrByBranch: async () => null,
    createPR: async (o, r, opts) => {
      if (opts.head) throw validationFailed();
      return { number: 98, html_url: 'x', head: { repo: { owner: { login: 'usernode-bot' } } } };
    },
  });
  const result = await withStubbedMirror(
    async () => ({
      ok: true, branch: 'usernode/from-someuser-t31-cafe', credential: 'pat',
      cleanup: async () => { cleaned = true; },
    }),
    () => withFetch(PUSHED_BRANCH, [], () => svc.submitWork(
      { pool: submitPool([]), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
      {
        user: { id: 3 }, taskId: 31,
        importProposal: async () => ({ ok: false, status: 409, body: { error: 'already imported' } }),
      }
    ))
  );
  assert.equal(result.code, 'import_failed');
  assert.equal(cleaned, true, 'a head the platform wrote and could not use is litter — remove it');
});

test('a mirror the platform refuses is reported as its own reason, not as GitHub’s', async () => {
  // "That branch is in somebody else's repository" is a better answer than
  // GitHub's 422, and a different one: it tells the user what to fix.
  const gh = ghWithDiagnostics({
    findOpenPrByBranch: async () => null,
    createPR: async () => { throw validationFailed(); },
  });
  for (const [code, message] of [['fork_mismatch', 'not yours'], ['base_mismatch', 'wrong base']]) {
    const result = await withStubbedMirror(
      async () => ({ ok: false, code, message }),
      () => withFetch(PUSHED_BRANCH, [], () => svc.submitWork(
        { pool: submitPool([]), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
        { user: { id: 3 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) }
      ))
    );
    assert.equal(result.code, code);
    assert.equal(result.message, message);
  }

  // Anything else falls back to the typed GitHub error, which now says what
  // actually happened rather than "could not be opened".
  const fellBack = await withStubbedMirror(
    async () => ({ ok: false, code: 'platform_unavailable', message: 'git was unhappy' }),
    () => withFetch(PUSHED_BRANCH, [], () => svc.submitWork(
      { pool: submitPool([]), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
      { user: { id: 3 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) }
    ))
  );
  assert.equal(fellBack.code, 'pr_open_failed');
  assert.match(fellBack.message, /HTTP 422/);
  assert.ok(fellBack.compareUrl);
});

test('slug + branch with no taskId finds the caller’s open work for that app', async () => {
  // An agent that lost its task id is not stuck.
  const queries = [];
  const created = [];
  const pool = fakePool([
    ["a.slug = $2 AND t.status = 'open'", [TASK_ROW]],
    ['UPDATE chat_sessions SET external_agent', []],
    ['UPDATE external_agent_tasks', []],
  ], queries);
  const gh = baseGh({
    findOpenPrByBranch: async () => null,
    createPR: async (o, r, opts) => {
      created.push(opts);
      return { number: 99, html_url: 'x', head: { repo: { owner: { login: 'someuser' } } } };
    },
  });
  const result = await withFetch({
    'GET /repos/someuser/recipe-box/branches/claude%2Fharness-made-this': {
      status: 200, body: { commit: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
    },
  }, [], () => svc.submitWork(
    { pool, config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, slug: 'recipe-box', branch: 'claude/harness-made-this',
      repoUrl: 'https://github.com/usernode-bot/recipe-box',
      importProposal: async () => ({ ok: true, body: { sessionId: 85 } }),
    }
  ));
  assert.equal(result.ok, true);
  assert.equal(created[0].head, 'someuser:claude/harness-made-this');
  // The reservation it found is still closed out properly.
  assert.ok(queries.some((q) => q.sql.includes('UPDATE external_agent_tasks')));
});

// ── maintainer_can_modify, and the fork_collab refusal it prevents ─────
//
// Rung 1 failed on every production attempt for one reason, and it was
// neither ambiguity nor scopes nor credential reach: `POST /pulls` treats
// `maintainer_can_modify` as true when omitted, which on a cross-fork head
// asks GitHub to grant the BASE repo's maintainers push access to the fork
// branch. Only a collaborator on that fork may grant it, and `usernode-bot`
// is a collaborator on nobody's fork by design. GitHub answered 422
// `field: "fork_collab"` on both rungs, so the mirror ran every time
// (task 3, 2026-08-07).

test('every cross-fork rung declines the maintainer-edit grant', async () => {
  const attempts = [];
  const gh = ghWithDiagnostics({
    findOpenPrByBranch: async () => null,
    createPR: async (owner, repo, opts) => {
      attempts.push(opts);
      return { number: 52, html_url: 'x', head: { repo: { owner: { login: 'someuser' } } } };
    },
  });

  const result = await withFetch(PUSHED_BRANCH, [], () => svc.submitWork(
    { pool: submitPool([]), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, taskId: 31,
      importProposal: async () => ({ ok: true, status: 200, body: { sessionId: 90 } }),
    }
  ));

  assert.equal(result.ok, true);
  assert.equal(attempts.length, 1, 'rung 1 now succeeds — no retry, no mirror');
  assert.equal(attempts[0].maintainerCanModify, false,
    'the platform never asks for write access to somebody else’s fork');
});

test('rung 1 succeeding is recorded as `branch`, and the mirror never runs', async () => {
  // The acceptance signal for this fix: `submitted_via` moving off
  // 'mirror' is how we know the parameter did its job in production.
  const queries = [];
  let mirrorCalled = false;
  const gh = ghWithDiagnostics({
    findOpenPrByBranch: async () => null,
    createPR: async (owner, repo, opts) => {
      // Refuse anything that still asks for the grant, exactly as GitHub does.
      if (opts.maintainerCanModify !== false) throw forkCollabRefused();
      return { number: 53, html_url: 'x', head: { repo: { owner: { login: 'someuser' } } } };
    },
  });

  const result = await withStubbedMirror(
    async () => { mirrorCalled = true; return { ok: false, code: 'unexpected' }; },
    () => withFetch(PUSHED_BRANCH, [], () => svc.submitWork(
      { pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
      {
        user: { id: 3 }, taskId: 31, source: 'work_order',
        importProposal: async () => ({ ok: true, status: 200, body: { sessionId: 91 } }),
      }
    ))
  );

  assert.equal(result.ok, true);
  assert.equal(result.submittedVia, 'branch');
  assert.equal(mirrorCalled, false);

  const close = queries.find((q) => q.sql.includes('UPDATE external_agent_tasks'));
  assert.ok(close.params.includes('branch'),
    'submitted_via records the rung that actually ran');
});

// GitHub's fork_collab 422, verbatim from the production log line that
// finally named this failure.
function forkCollabRefused() {
  const err = new Error('Validation Failed');
  err.status = 422;
  err.code = 'fork_collab_denied';
  err.response = {
    status: 422,
    headers: { 'x-github-request-id': 'A1D8:13D72D', 'x-oauth-scopes': 'repo, workflow' },
    data: {
      message: 'Validation Failed',
      errors: [{
        resource: 'PullRequest',
        code: 'custom',
        field: 'fork_collab',
        message: "fork_collab Fork collab can't be granted by someone without permission",
      }],
    },
  };
  return err;
}

test('a fork_collab refusal STOPS the ladder — it is our bug, not a repo condition', async () => {
  // Retrying with head_repo cannot help and mirroring would paper over a
  // defect at the call site, so neither happens. Unreachable once every
  // cross-fork caller sends `false` — which is exactly why it is named.
  const attempts = [];
  let mirrorCalled = false;
  const gh = ghWithDiagnostics({
    findOpenPrByBranch: async () => null,
    createPR: async (owner, repo, opts) => {
      attempts.push(opts);
      throw forkCollabRefused();
    },
  });

  const result = await withStubbedMirror(
    async () => { mirrorCalled = true; return { ok: false, code: 'unexpected' }; },
    () => withFetch(PUSHED_BRANCH, [], () => svc.submitWork(
      { pool: submitPool([]), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
      {
        user: { id: 3 }, taskId: 31,
        importProposal: async () => ({ ok: true, status: 200, body: { sessionId: 92 } }),
      }
    ))
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'fork_collab_denied');
  assert.equal(result.retryable, false, 'retrying a deterministic refusal is not the answer');
  assert.match(result.message, /only a collaborator on that fork can grant it/i);
  assert.match(result.message, /bug on our side/i,
    'says whose fault it is, so nobody re-audits their fork');
  assert.equal(attempts.length, 1, 'no head_repo retry');
  assert.equal(mirrorCalled, false, 'and no mirror');
});

test('an ordinary 422 still walks the whole ladder — only fork_collab short-circuits', async () => {
  // Guard against the typed stop swallowing the fallback it sits beside.
  const attempts = [];
  let mirrorCalled = false;
  const gh = ghWithDiagnostics({
    findOpenPrByBranch: async () => null,
    createPR: async (owner, repo, opts) => {
      attempts.push(opts);
      if (opts.head) throw validationFailed();
      return { number: 98, html_url: 'x', head: { repo: { owner: { login: 'usernode-bot' } } } };
    },
  });

  const result = await withStubbedMirror(
    async () => {
      mirrorCalled = true;
      return {
        ok: true,
        branch: 'usernode/from-someuser-t31-cafe',
        credential: 'pat',
        cleanup: async () => {},
      };
    },
    () => withFetch(PUSHED_BRANCH, [], () => svc.submitWork(
      { pool: submitPool([]), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
      {
        user: { id: 3 }, taskId: 31,
        importProposal: async () => ({ ok: true, status: 200, body: { sessionId: 93 } }),
      }
    ))
  );

  assert.equal(result.ok, true);
  assert.equal(result.submittedVia, 'mirror');
  assert.equal(mirrorCalled, true);
  assert.equal(attempts.length, 3, 'cross-fork, cross-fork + head_repo, then same-repo');
  assert.equal(attempts[0].maintainerCanModify, false);
  assert.equal(attempts[1].maintainerCanModify, false, 'rung 2 declines the grant too');
  assert.equal(attempts[2].maintainerCanModify, undefined,
    'the same-repo mirror create keeps GitHub’s default — the grant is vacuous there');
});

test('the mirror announces which rung failed and why', async () => {
  // Cross-fork creates now decline the grant, so rung 1 is expected to
  // succeed and this line should stop appearing. Its presence in the log
  // is the signal that something new is refusing the fork head — visible
  // without anyone going and querying submitted_via.
  const lines = [];
  const realInfo = logger.info;
  logger.info = (scope, msg, meta) => { lines.push({ scope, msg, meta }); };

  const gh = ghWithDiagnostics({
    findOpenPrByBranch: async () => null,
    createPR: async (owner, repo, opts) => {
      if (opts.head) throw validationFailed();
      return { number: 99, html_url: 'x', head: { repo: { owner: { login: 'usernode-bot' } } } };
    },
  });

  try {
    await withStubbedMirror(
      async () => ({
        ok: true,
        branch: 'usernode/from-someuser-t31-feed',
        credential: 'pat',
        cleanup: async () => {},
      }),
      () => withFetch(PUSHED_BRANCH, [], () => svc.submitWork(
        { pool: submitPool([]), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
        {
          user: { id: 3 }, taskId: 31,
          importProposal: async () => ({ ok: true, status: 200, body: { sessionId: 94 } }),
        }
      ))
    );
  } finally {
    logger.info = realInfo;
  }

  const line = lines.find((l) => /falling back to the mirror/.test(l.msg));
  assert.ok(line, 'the fallback is announced, not silent');
  assert.equal(line.meta.failedRungs, 'branch, branch_head_repo');
  assert.equal(line.meta.status, 422);
  assert.equal(line.meta.githubField, 'head', 'names the field GitHub objected to');
  assert.equal(line.meta.requestId, 'ABCD:1234:5678');
  assert.equal(line.meta.head, 'someuser:usernode/recipe-box-issue-4-abc123');
});
