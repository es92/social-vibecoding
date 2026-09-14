// #1347 — the connector's SECOND destination: the in-progress area.
//
// submit_work used to have exactly one place to put finished work: a group
// vote. That is the right destination for work that is DONE, and the wrong one
// for work that is still moving — an agent part-way through a long change
// could either keep it invisible or put a half-finished branch in front of
// reviewers. `share: true` is the other destination.
//
// What these tests are weighted toward, in order:
//
//   1. IT IS THE SAME MACHINERY. A shared card is an ordinary dev session with
//      `shared_at` set — the thing routes/issues.js already composes the
//      In-progress area from, and the same flag the owner's own Share button
//      writes. The route creates the row and then hands it to
//      proposal-update.updateProposalFromForkBranch, which owns the fork
//      attribution gate. A second implementation of that gate is the bug this
//      design exists to avoid.
//   2. NO DUPLICATE PROPOSALS. Once work is shared, every follow-up must land
//      on the SAME card: sharing again pushes commits onto it, and a plain
//      submit is refused with the call that promotes it. A branch the group
//      can already see must never end up with a second proposal beside it.
//   3. THE RESERVATION SURVIVES. Sharing says "underway", so the work order
//      stays open and the agent keeps committing.
//   4. IT COSTS A CONTAINER, SO IT IS CAPPED. The card carries a real staging
//      preview, bounded by the same per-user active-session cap the browser's
//      own "start a session" button obeys — and counted before anything is
//      written, so a refusal leaves no card behind.
//
// Run with: node --test tests/connector-share-in-progress.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const svc = require('../src/services/external-agent-tasks');
const limits = require('../src/services/connector-limits');
const head = require('../src/services/external-agent-head');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ROUTE_SRC = read('src/routes/proposal-handoff.js');
const TOOLS_SRC = read('src/services/mcp-tools.js');
const POLICY_SRC = read('src/services/cli-api-policy.js');

// ── Fakes, matching tests/external-agent-tasks.test.js ─────────────────

function fakePool(handlers, queries) {
  return {
    async query(sql, params) {
      queries.push({ sql, params });
      for (const [needle, rows] of handlers) {
        if (sql.includes(needle)) {
          return { rows: typeof rows === 'function' ? rows(params) : rows, rowCount: 1 };
        }
      }
      throw new Error(`unstubbed query: ${sql.slice(0, 80)}`);
    },
  };
}

const okLimits = {
  checkOpenWorkOrders: async () => null,
  checkPromotedCap: async () => null,
  checkActiveCap: async () => null,
};

const baseGh = (overrides = {}) => ({
  isEnabled: () => true,
  parseGithubUrl: (url) => {
    const m = /github\.com\/([^/]+)\/([^/.]+)/.exec(String(url || ''));
    return m ? { owner: m[1], repo: m[2] } : null;
  },
  ...overrides,
});

const linkedAs = (login) => ({
  isEnabled: () => true,
  linkStatus: async () => ({ linked: true, login, linkedAt: null, access: 'identity' }),
});

const TASK_ROW = {
  id: 31, user_id: 3, app_id: 7, issue_number: 4,
  fork_owner: 'someuser', fork_repo: 'recipe-box',
  branch_name: 'usernode/recipe-box-issue-4-abc123',
  base_sha: '0123456789abcdef0123456789abcdef01234567',
  brief: 'Add dark mode', status: 'open', session_id: null,
  app_slug: 'recipe-box', app_name: 'Recipe Box',
  repo_url: 'https://github.com/usernode-bot/recipe-box',
};

function sharePool(queries, task = TASK_ROW) {
  return fakePool([
    ['FROM external_agent_tasks t JOIN apps a', [task]],
    ['UPDATE external_agent_tasks', []],
  ], queries);
}

function shareDeps(queries, task) {
  return {
    pool: sharePool(queries, task),
    config: {},
    gh: baseGh(),
    githubLink: linkedAs('someuser'),
    limits: okLimits,
  };
}

// ── 1. The happy path ──────────────────────────────────────────────────

test('share: true lands the work in the in-progress area, not at a vote', async () => {
  const queries = [];
  const shares = [];
  const result = await svc.submitWork(shareDeps(queries), {
    user: { id: 3 },
    clientName: 'Claude',
    taskId: 31,
    branch: 'my-branch',
    share: true,
    title: 'Dark mode',
    body: 'Half of it works.',
    shareWork: async (slug, payload) => {
      shares.push({ slug, payload });
      return { ok: true, status: 200, body: { sessionId: 77, previewRebuilding: true } };
    },
    // Present, and deliberately never reached: a share must not open a PR.
    importProposal: async () => { throw new Error('importProposal must not run for a share'); },
  });

  assert.equal(result.ok, true);
  assert.equal(result.shared, true);
  assert.equal(result.sessionId, 77);
  assert.equal(result.prNumber, null, 'a shared card has no pull request');
  assert.equal(result.previewRebuilding, true, 'and it does get a staging preview');
  assert.equal(shares.length, 1);
  assert.equal(shares[0].slug, 'recipe-box');
  assert.equal(shares[0].payload.branch, 'my-branch');
  // The badge is resolved in the service, so a shared card reads the same as a
  // proposal from the same agent.
  assert.equal(shares[0].payload.externalAgent, 'claude-code');
  // The request travels with it, exactly as it does on the submit path.
  assert.deepEqual(shares[0].payload.linkedIssues, [4]);
});

test('the work order STAYS OPEN and records the card it produced', async () => {
  const queries = [];
  await svc.submitWork(shareDeps(queries), {
    user: { id: 3 },
    clientName: 'Claude',
    taskId: 31,
    branch: 'my-branch',
    share: true,
    shareWork: async () => ({ ok: true, status: 200, body: { sessionId: 77 } }),
  });

  const stamp = queries.find((q) => q.sql.includes('UPDATE external_agent_tasks'));
  assert.ok(stamp, 'the task row is stamped');
  // The whole point: sharing does not spend the reservation. A submission
  // writes `status = 'submitted'` here; a share must not, or the agent would
  // need a fresh work order to keep committing to work it just called underway.
  assert.doesNotMatch(stamp.sql, /status\s*=\s*'submitted'/,
    'sharing must not close the work order');
  assert.match(stamp.sql, /session_id\s*=/, 'but it does record the card');
  assert.ok(stamp.params.includes(77), 'with the session id it just created');
});

// ── 2. No duplicate proposals for one branch ───────────────────────────

const SHARED_TASK = { ...TASK_ROW, session_id: 77 };

test('sharing twice pushes onto the SAME card instead of making a second', async () => {
  const queries = [];
  const advanced = [];
  const result = await svc.submitWork(shareDeps(queries, SHARED_TASK), {
    user: { id: 3 },
    clientName: 'Claude',
    taskId: 31,
    branch: 'my-branch',
    share: true,
    updateProposal: async (slug, id, payload) => {
      advanced.push({ slug, id, payload });
      return { ok: true, status: 200, body: { headSha: 'abc', previewRebuilding: true } };
    },
    shareWork: async () => { throw new Error('a second card must not be created'); },
  });

  assert.equal(result.ok, true);
  assert.equal(result.shared, true);
  assert.equal(result.reshared, true);
  assert.equal(result.sessionId, 77, 'the same card');
  assert.equal(advanced.length, 1);
  assert.equal(advanced[0].id, 77, 'advanced through the ordinary update path');
});

// ── 2b. Each payload has to FIT the route it is posted to ──────────────
//
// The share path talks to two different routes — share-in-progress to create
// the card, update-from-fork to advance it — and for a while it built ONE
// payload and sent it to both. Both routes parse their body with `exactKeys`,
// which does not ignore an unknown field: it refuses the whole request. So a
// key accepted by one and not the other is not a cosmetic mismatch, it is an
// outage on the path that does not accept it.
//
// That is what shipped. `externalAgent` is a share-in-progress field, and
// sending it to update-from-fork made EVERY reshare fail with
// `invalid_request` — sharing a second time onto the same card, which is the
// documented way to keep committing to shared work, could not work at all.
// The stub in the test above accepts any payload, so nothing caught it.
//
// These two tests close that by reading the ROUTE's own key lists rather than
// restating them here: a field added to one payload and not to the matching
// route now fails at `npm test` instead of in production.

function acceptedKeys(parserName) {
  const at = ROUTE_SRC.indexOf(`function ${parserName}(body)`);
  assert.ok(at > 0, `${parserName} is still the body parser — re-anchor this test`);
  const call = /exactKeys\(body, \[([^\]]*)\]/.exec(ROUTE_SRC.slice(at, at + 900));
  assert.ok(call, `${parserName} still validates with exactKeys`);
  return new Set(call[1].split(',').map((k) => k.trim().replace(/^'|'$/g, '')).filter(Boolean));
}

async function payloadFor(task, extra = {}) {
  let seen = null;
  await svc.submitWork(shareDeps([], task), {
    user: { id: 3 },
    clientName: 'Claude',
    taskId: 31,
    branch: 'my-branch',
    share: true,
    title: 'Dark mode',
    body: 'Half of it works.',
    testing: { testingPaths: [{ path: '/', viewport: 'desktop' }], testingSteps: '1. Look.' },
    expectedHeadSha: 'a'.repeat(40),
    shareWork: async (slug, payload) => {
      seen = payload;
      return { ok: true, status: 200, body: { sessionId: 77 } };
    },
    updateProposal: async (slug, id, payload) => {
      seen = payload;
      return { ok: true, status: 200, body: { headSha: 'abc' } };
    },
    ...extra,
  });
  assert.ok(seen, 'the route was called');
  return seen;
}

test('the CREATE payload is a body share-in-progress will accept', async () => {
  const payload = await payloadFor(TASK_ROW);
  const accepted = acceptedKeys('parseShareInProgressBody');
  for (const key of Object.keys(payload)) {
    assert.ok(accepted.has(key), `share-in-progress rejects an unknown \`${key}\``);
  }
  // And the badge is here, on the call that CREATES the card — which is the
  // only moment there is anything to set it on.
  assert.equal(payload.externalAgent, 'claude-code');
});

test('the RESHARE payload is a body update-from-fork will accept', async () => {
  const payload = await payloadFor(SHARED_TASK);
  const accepted = acceptedKeys('parseUpdateFromForkBody');
  for (const key of Object.keys(payload)) {
    assert.ok(accepted.has(key), `update-from-fork rejects an unknown \`${key}\``);
  }
  // Named explicitly as well as caught by the sweep above, because this one
  // field is the whole bug and a future edit should have to read why.
  assert.ok(!('externalAgent' in payload),
    'the badge is set when the card is created; a reshare advances a card '
    + 'that already carries it, and update-from-fork refuses the field');
  // The rest of the payload still travels — this is not "send less".
  assert.equal(payload.branch, 'my-branch');
  assert.equal(payload.title, 'Dark mode');
  assert.equal(payload.description, 'Half of it works.');
  assert.deepEqual(payload.linkedIssues, [4]);
});

test('a plain submit on shared work is refused, and names the call that promotes it', async () => {
  const queries = [];
  const result = await svc.submitWork(shareDeps(queries, SHARED_TASK), {
    user: { id: 3 },
    clientName: 'Claude',
    taskId: 31,
    branch: 'my-branch',
    // No `share` — the caller means "put it up for review".
    importProposal: async () => { throw new Error('must not open a second proposal'); },
    updateProposal: async () => ({ ok: true, status: 200, body: {} }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'already_shared');
  // The refusal has to be actionable: an agent that is told "no" and not told
  // "call this instead" opens the duplicate by hand.
  assert.match(result.message, /proposalId 77/);
  assert.match(result.message, /propose: true/);
});

// ── 3. Shapes that cannot mean "still underway" ────────────────────────

test('a patch or an open PR cannot be shared — both are review artefacts', async () => {
  for (const extra of [{ patch: 'diff --git a b' }, { prNumber: 12 }]) {
    const result = await svc.submitWork(shareDeps([]), {
      user: { id: 3 },
      clientName: 'Claude',
      taskId: 31,
      branch: 'my-branch',
      share: true,
      shareWork: async () => { throw new Error('must not share'); },
      ...extra,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_request');
    assert.match(result.message, /drop `share`/);
  }
});

test('a client with no share loopback says so rather than silently proposing', async () => {
  const result = await svc.submitWork(shareDeps([]), {
    user: { id: 3 }, clientName: 'Claude', taskId: 31, branch: 'my-branch', share: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'platform_unavailable');
});

// ── 4. The cap that pays for the preview ───────────────────────────────

test('checkActiveCap counts the caller\'s own active sessions, headless excluded', async () => {
  const seen = [];
  const pool = {
    async query(sql, params) {
      seen.push({ sql, params });
      return { rows: [{ cnt: '3' }] };
    },
  };
  const err = await limits.checkActiveCap(pool, {}, { id: 3 });
  assert.ok(err, 'three sessions is at the default cap of three');
  assert.equal(err.code, 'at_capacity');
  // The refusal names the other destination, which is not capped this way.
  assert.match(err.message, /submit this work for review/);
  assert.match(seen[0].sql, /status = 'active'/);
  assert.match(seen[0].sql, /is_headless = FALSE/);
});

test('under the cap it permits, and a full admin gets the admin tier', async () => {
  const pool = { async query() { return { rows: [{ cnt: '2' }] }; } };
  assert.equal(await limits.checkActiveCap(pool, {}, { id: 3 }), null);
  // 3 is the base cap and 5 the admin one, so a full admin at 3 still passes.
  const atThree = { async query() { return { rows: [{ cnt: '3' }] }; } };
  assert.equal(await limits.checkActiveCap(atThree, {}, { id: 3, canAdminWrite: true }), null);
});

test('a cap query that cannot run refuses rather than waving the write through', async () => {
  const pool = { async query() { throw new Error('db down'); } };
  const err = await limits.checkActiveCap(pool, {}, { id: 3 });
  assert.ok(err, 'an unavailable limiter is a reason to stop');
});

// ── 5. The route: same machinery, and no litter ────────────────────────

function shareRoute() {
  const m = ROUTE_SRC.match(
    /router\.post\('\/api\/apps\/:slug\/work\/share-in-progress'[\s\S]*?\n  \}\);/
  );
  assert.ok(m, 'the share-in-progress route is registered');
  return m[0];
}

test('the route creates a SHARED, ACTIVE session and hands it to the shared gate', () => {
  const route = shareRoute();
  // Shared at creation: a row that exists unshared, even briefly, is a private
  // session the caller never asked for.
  assert.match(route, /INSERT INTO chat_sessions[\s\S]*?'active', NOW\(\)/,
    'created active (the status that carries a preview and can be promoted) and shared');
  // The attribution gate is NOT re-implemented here.
  assert.match(route, /proposalUpdate\.updateProposalFromForkBranch/,
    'the fork branch is landed by the same function every other hand-off uses');
  // The access gate and the cap, both before the insert.
  const insertAt = route.indexOf('INSERT INTO chat_sessions');
  const capAt = route.indexOf('checkActiveCap');
  const accessAt = route.indexOf('getAppForUser');
  assert.ok(accessAt !== -1 && capAt !== -1 && insertAt !== -1);
  assert.ok(accessAt < insertAt, 'app access is checked before anything is written');
  assert.ok(capAt < insertAt, 'and so is the cap, so a refusal leaves no card');
});

test('the row records an APP-REPO branch of the platform\'s own, not the caller\'s fork branch', () => {
  const route = shareRoute();
  // `branch_name` on a session is the branch in the APP repository —
  // the one the landing pushes to, the one promote opens a pull request from,
  // and the one `platformOwnedBranch` reads to decide, from the row alone,
  // where a source-less session's head lives. The caller's fork branch is a
  // different thing and travels separately, as `branch`.
  assert.match(route, /externalAgentHead\.shareBranchName\(req\.user\.id\)/,
    'the app-repo branch is minted here');
  const insert = route.slice(route.indexOf('INSERT INTO chat_sessions'));
  assert.match(insert, /appRepoBranch,/, 'and it is what the row stores');
  assert.doesNotMatch(insert.slice(0, insert.indexOf('RETURNING id') + 400), /input\.branch,/,
    "the caller's fork branch name never lands in the app repo's namespace");
  // It still travels to the landing, which reads it from the FORK.
  assert.match(route, /branch: input\.branch,/);
});

test('a shared branch name is in Homeroom\'s namespace and is always a valid ref', () => {
  const seen = new Set();
  for (const id of [1, 7, 4021, 0, null, undefined, 'not-a-number']) {
    const name = head.shareBranchName(id);
    assert.ok(name.startsWith(head.MIRROR_BRANCH_PREFIX), name);
    assert.ok(head.isMirrorNamespace(name), name);
    assert.ok(head.validRef(name), name);
    seen.add(name);
  }
  assert.equal(seen.size, 7, 'the nonce makes two shares by one user two branches');
  // Minted from the USER ID, never a username: 194 of 303 production
  // usernames are email addresses, and `@`/`+` are outside the ref charset
  // this file's validRef enforces (services/branch-names.js has the story).
  assert.ok(head.validRef(head.shareBranchName(7)));
  assert.equal(head.validRef('usernode/from-alice@example.com-s0badf00d'), false);
});

test('a mirror will not write a branch name that is not one of ours', async () => {
  // The mirror pushes into the APP's repository with the platform's own
  // credential. A target branch supplied by a caller is checked against the
  // namespace rather than trusted — the same rule the minted names obey.
  const refused = await head.mirrorForkBranch({
    githubPublic: {}, owner: 'o', repo: 'r', forkOwner: 'evan-gh', forkRepo: 'r',
    branch: 'fix/thing', expectedLogin: 'evan-gh',
    targetBranch: 'main',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'invalid_request');
});

test('a failed hand-off deletes the card it had just created', () => {
  const route = shareRoute();
  const failAt = route.indexOf('if (!result.ok)');
  assert.ok(failAt !== -1, 'the failure branch exists');
  const failBranch = route.slice(failAt);
  assert.match(failBranch, /DELETE FROM chat_sessions WHERE id = \$1 AND user_id = \$2/,
    'a half-made card with no commits behind it is worse than the refusal');
});

test('the route is on the connector allowlist', () => {
  assert.match(
    POLICY_SRC,
    /\{ method: 'POST', pattern: '\/api\/apps\/:slug\/work\/share-in-progress' \}/,
    'a tool route the policy does not know about is refused at the door'
  );
});

// ── 6. The tool surface ────────────────────────────────────────────────

test('submit_work offers the second destination and reports which one it took', () => {
  assert.match(TOOLS_SRC, /share: z\.boolean\(\)\.optional\(\)/, 'the input exists');
  assert.match(TOOLS_SRC, /shared: z\.boolean\(\)\.nullable\(\)/, 'and the answer says which destination');
  assert.match(TOOLS_SRC, /sessionId: z\.number\(\)\.nullable\(\)/,
    'with the id a later submit_work passes as proposalId');
  // The loopback, on the same arrangement as the other two.
  assert.match(TOOLS_SRC, /work\/share-in-progress`, payload/);
  // The shared answer must not talk about votes, checks or merging — none of
  // them apply to a card nobody has been asked to approve.
  const m = TOOLS_SRC.match(/if \(result\.shared\) \{[\s\S]*?\n    \}/);
  assert.ok(m, 'the shared branch exists');
  // It must say the OPPOSITE of the submit path, not merely avoid the words:
  // "no votes are being collected" is the fact an agent needs, and a bare
  // absence would read the same as a description that forgot to mention it.
  assert.match(m[0], /not up for a vote/i, 'it states the destination it did NOT take');
  assert.doesNotMatch(m[0], /checks and the staging preview build automatically/i,
    'and borrows none of the submit path\'s vote-and-checks wording');
  assert.match(m[0], /no votes are being collected/i);
  assert.match(m[0], /IN-PROGRESS area/);
  assert.match(m[0], /propose: true/, 'and it names how to send it on');
});

test('the cross-cutting rule lives in the charter, where it is not truncated', () => {
  const charter = require('../src/services/mcp-charter');
  const section = charter.CHARTER_SECTIONS.find((s) => s.id === 'two-destinations');
  assert.ok(section, 'the charter carries the whole rule');
  assert.match(section.text, /share: true/);
  assert.match(section.text, /IN-PROGRESS/);
  assert.match(section.text, /active-session cap/, 'including what it costs');
  // Charter-only: it must NOT be in the always-delivered instructions, which
  // the client cuts at 2048 with no ellipsis.
  assert.ok(!section.brief, 'no brief — this binds a reader several calls in');
});
