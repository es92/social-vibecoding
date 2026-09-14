// A session's branch is created on its FIRST TURN, not when it is created
// (#1350).
//
// What this replaces: POST /api/apps/:slug/sessions used to mint a name and
// call github.createBranch before it returned, so opening the composer and
// closing the tab left a real ref on the app's repository. Most sessions are
// opened and abandoned, so most of those branches were never written to and
// never cleaned up.
//
// The deferral moves one line and adds four obligations, and this file pins
// all of them:
//
//   1. the creation route inserts branch_name NULL and calls no GitHub API
//   2. ensureSessionBranch is idempotent, serialized, and all-or-nothing
//   3. the three HEADLESS creation paths keep minting up front, because a
//      run with no human in it has no "first message" to defer to
//   4. every surface that reads branch_name copes with NULL rather than
//      producing a name-shaped hole ('heads/null', 'origin/null')
//
// Obligation 2's third clause is the load-bearing one. run-cc.sh dies on
// "branch missing upstream: origin/$BRANCH" for a build turn, so a row that
// records a branch GitHub does not have is a session that can never run a
// turn again. The helper therefore persists the name only AFTER the ref
// exists, and holds the row lock across the call so two concurrent first
// turns cannot mint two names for one session.
//
// Run with: node --test tests/session-branch-deferral.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── a pool stand-in ─────────────────────────────────────────────────────
//
// ensureSessionBranch is the only thing under test, and it touches exactly
// one client with a scripted set of statements. Matching on the shape of
// the SQL rather than mocking pg keeps the test honest about the ORDER the
// statements run in, which is the part that matters.
function fakePool(rowsBySession, opts = {}) {
  const log = [];
  const releases = { count: 0 };
  const pool = {
    log,
    releases,
    async connect() {
      let txRows = null;
      return {
        async query(sql, params) {
          const text = String(sql).replace(/\s+/g, ' ').trim();
          log.push(text);
          if (/^BEGIN|^COMMIT|^ROLLBACK/.test(text)) return { rows: [] };
          if (/FOR UPDATE OF cs/.test(text)) {
            txRows = rowsBySession.get(Number(params[0])) || null;
            return { rows: txRows ? [{ ...txRows }] : [] };
          }
          if (/UPDATE chat_sessions SET branch_name/.test(text)) {
            if (opts.failUpdate) throw new Error('update exploded');
            const row = rowsBySession.get(Number(params[0]));
            if (row) row.branch_name = params[1];
            return { rowCount: 1, rows: [] };
          }
          throw new Error(`unexpected statement: ${text}`);
        },
        release() { releases.count += 1; },
      };
    },
  };
  return pool;
}

function loadLifecycle() {
  // github.isEnabled() is false with no GitHub App configured, which is the
  // shape this container runs in. The helper then persists the name without
  // calling out, which is exactly the path a self-hosted deployment with no
  // GitHub App takes in production.
  return require('../src/services/session-lifecycle');
}

// ── the helper ──────────────────────────────────────────────────────────

test('ensureSessionBranch mints a name for a branchless session', async () => {
  const lifecycle = loadLifecycle();
  const rows = new Map([[7, {
    id: 7, branch_name: null, user_id: 3, username: 'evan', repo_url: null,
  }]]);
  const pool = fakePool(rows);

  const out = await lifecycle.ensureSessionBranch({ pool, sessionId: 7 });
  assert.equal(out.created, true);
  assert.match(out.branchName, /^dev\/evan-\d+$/);
  assert.equal(rows.get(7).branch_name, out.branchName, 'the name must be persisted');
  assert.equal(pool.releases.count, 1, 'the client must always be released');
});

test('ensureSessionBranch sanitizes an email-address username', async () => {
  // The #1376 regression, re-pinned at the new mint site: 194 of 303
  // production usernames are email addresses.
  const lifecycle = loadLifecycle();
  const branchNames = require('../src/services/branch-names');
  const rows = new Map([[7, {
    id: 7, branch_name: null, user_id: 3, username: 'koenigup@gmail.com', repo_url: null,
  }]]);
  const out = await lifecycle.ensureSessionBranch({ pool: fakePool(rows), sessionId: 7 });
  assert.ok(branchNames.isValidBranchName(out.branchName), `${out.branchName} must be pushable`);
});

test('ensureSessionBranch is idempotent: a second call returns the same branch', async () => {
  const lifecycle = loadLifecycle();
  const rows = new Map([[7, {
    id: 7, branch_name: null, user_id: 3, username: 'evan', repo_url: null,
  }]]);
  const pool = fakePool(rows);

  const first = await lifecycle.ensureSessionBranch({ pool, sessionId: 7 });
  const second = await lifecycle.ensureSessionBranch({ pool, sessionId: 7 });
  assert.equal(second.branchName, first.branchName);
  assert.equal(second.created, false, 'the second call must not claim to have created it');
  // And it must not have tried: a second CREATE for an existing ref is a
  // 422 from GitHub, which would surface as a failed turn.
  assert.equal(
    pool.log.filter((s) => s.startsWith('UPDATE chat_sessions')).length, 1,
    'only the first call may write'
  );
});

test('ensureSessionBranch reads the row FOR UPDATE, inside a transaction', async () => {
  // This is what serializes two concurrent first turns on one session.
  const lifecycle = loadLifecycle();
  const rows = new Map([[7, {
    id: 7, branch_name: null, user_id: 3, username: 'evan', repo_url: null,
  }]]);
  const pool = fakePool(rows);
  await lifecycle.ensureSessionBranch({ pool, sessionId: 7 });

  assert.equal(pool.log[0], 'BEGIN', 'the read must be inside a transaction');
  assert.match(pool.log[1], /FOR UPDATE OF cs/);
  assert.match(pool.log[2], /^UPDATE chat_sessions/);
  assert.equal(pool.log[3], 'COMMIT');
});

test('ensureSessionBranch prefers the caller-supplied username', async () => {
  // The chat route has req.user in hand; the row's join may be NULL for a
  // deleted account.
  const lifecycle = loadLifecycle();
  const rows = new Map([[7, {
    id: 7, branch_name: null, user_id: 3, username: null, repo_url: null,
  }]]);
  const out = await lifecycle.ensureSessionBranch({
    pool: fakePool(rows), sessionId: 7, username: 'ada',
  });
  assert.match(out.branchName, /^dev\/ada-\d+$/);
});

test('ensureSessionBranch still produces a valid name with no username at all', async () => {
  const lifecycle = loadLifecycle();
  const branchNames = require('../src/services/branch-names');
  const rows = new Map([[7, {
    id: 7, branch_name: null, user_id: 42, username: null, repo_url: null,
  }]]);
  const out = await lifecycle.ensureSessionBranch({ pool: fakePool(rows), sessionId: 7 });
  assert.ok(branchNames.isValidBranchName(out.branchName));
  assert.match(out.branchName, /^dev\//);
});

test('ensureSessionBranch reports a missing session as no_session', async () => {
  const lifecycle = loadLifecycle();
  const pool = fakePool(new Map());
  await assert.rejects(
    () => lifecycle.ensureSessionBranch({ pool, sessionId: 999 }),
    (err) => {
      assert.equal(err.code, 'no_session');
      return true;
    }
  );
  assert.equal(pool.releases.count, 1, 'the client must be released on the error path');
});

test('a failed write leaves the session branchless rather than half-created', async () => {
  const lifecycle = loadLifecycle();
  const rows = new Map([[7, {
    id: 7, branch_name: null, user_id: 3, username: 'evan', repo_url: null,
  }]]);
  const pool = fakePool(rows, { failUpdate: true });
  await assert.rejects(() => lifecycle.ensureSessionBranch({ pool, sessionId: 7 }));
  assert.equal(rows.get(7).branch_name, null, 'nothing may be persisted');
  assert.ok(pool.log.includes('ROLLBACK'), 'the transaction must be unwound');
  assert.equal(pool.releases.count, 1);
});

// ── the creation route ──────────────────────────────────────────────────

test('the interactive session route inserts a NULL branch and calls no GitHub API', () => {
  const src = read('src/routes/sessions.js');
  const start = src.indexOf("router.post('/api/apps/:slug/sessions'");
  assert.ok(start > 0, 'the creation route must still exist');
  // To the next route registration: the handler's whole body.
  const end = src.indexOf("router.post('", start + 10);
  const body = src.slice(start, end > 0 ? end : src.length);

  assert.match(body, /INSERT INTO chat_sessions[\s\S]*branch_name/,
    'the insert must still name the column');
  assert.match(body, /VALUES \(\$1, \$2, NULL,/,
    'branch_name must be inserted NULL (#1350)');
  assert.equal(
    /github\.createBranch\(/.test(body), false,
    'creating a session must not create a ref — that is the whole of #1350'
  );
  assert.equal(
    /branchNames\.devBranchName\(/.test(body), false,
    'the interactive route must not mint a name up front'
  );
});

test('the chat route ensures the branch before it dispatches a turn', () => {
  const src = read('src/routes/sessions.js');
  assert.match(src, /sessionLifecycle\.ensureSessionBranch\(/,
    'the chat handler must call the helper');

  // Order matters twice over. The ensure has to come before the message
  // INSERT (so a failed mint leaves no orphan user message in the
  // transcript) and before res.writeHead (after which a 503 is impossible,
  // because the response is already an SSE stream).
  const chat = src.indexOf("router.post('/api/sessions/:id/chat'");
  assert.ok(chat > 0);
  const ensure = src.indexOf('await sessionLifecycle.ensureSessionBranch(', chat);
  const insert = src.indexOf('INSERT INTO chat_session_messages', chat);
  const writeHead = src.indexOf('res.writeHead(200', chat);
  assert.ok(ensure > chat, 'the ensure must be inside the chat handler');
  assert.ok(ensure < insert, 'the branch must be ensured before the message is stored');
  assert.ok(ensure < writeHead, 'the branch must be ensured while a 503 is still possible');

  // And it is skipped once the row already carries a name. The helper is
  // idempotent on its own, so this is not about correctness: without the
  // guard every turn after the first would open a transaction and take a
  // row lock only to re-read a value this handler already has in hand.
  const guard = src.lastIndexOf('if (!String(session.branch_name || \'\').trim()) {', ensure);
  assert.ok(guard > chat && guard < ensure,
    'the ensure call must sit behind an already-has-a-branch guard');
});

test('the headless creation paths still mint up front, and say why', () => {
  const src = read('src/routes/sessions.js');
  // Three of them: an auto-issue run, a clone-headless run, and a fork.
  // None has a human on the other end to send a first message, so there is
  // nothing to defer to.
  const mints = src.match(/const branchName = [^;]+;/g) || [];
  assert.equal(mints.length, 3, 'expected exactly the three headless mints');
  const carveouts = src.match(/#1350 carve-out:/g) || [];
  assert.equal(
    carveouts.length, 3,
    'each retained mint must carry the comment explaining why it is not deferred'
  );
});

test('the fork paths never ask GitHub for heads/null', () => {
  // github.createBranch(owner, repo, name, fromBranch = 'main') defaults
  // only on undefined, so a NULL source branch_name would reach the API as
  // the literal string "null". Reachable now that a source session can be
  // branchless.
  const src = read('src/routes/sessions.js');
  const inherits = src.match(/createBranch\([^)]*src\.branch_name[^)]*\)/g) || [];
  assert.equal(inherits.length, 2, 'expected the clone and fork inheritance sites');
  for (const use of inherits) {
    assert.match(use, /\|\| 'main'/, `unguarded branch inheritance: ${use}`);
  }
});

// ── the null-branch edge cases ──────────────────────────────────────────

test('the push proxy refuses a branchless session permanently, with advice', async () => {
  const prev = process.env.GITHUB_BOT_TOKEN;
  process.env.GITHUB_BOT_TOKEN = 'ghp_test_token';
  try {
    const worker = require('../src/services/worker');
    for (const empty of [null, undefined, '']) {
      await assert.rejects(
        () => worker.execPushFromWorker(1, empty),
        (err) => {
          assert.equal(err.code, 'no_branch');
          assert.equal(err.permanent, true);
          assert.match(err.userMessage, /Send a message in the session first/i);
          return true;
        },
        `branch ${JSON.stringify(empty)} must be refused`
      );
    }
  } finally {
    if (prev === undefined) delete process.env.GITHUB_BOT_TOKEN;
    else process.env.GITHUB_BOT_TOKEN = prev;
  }
});

test('the no_branch guard runs before the charset check', () => {
  // Otherwise isValidBranchName(null) answers first and the user gets
  // "isn't a valid git branch name", which is true but useless: the fix is
  // to send a message, not to start a new session.
  const src = read('src/services/worker.js');
  const guard = src.indexOf("err.code = 'no_branch'");
  const charset = src.indexOf('branchNames.isValidBranchName(branchName)');
  assert.ok(guard > 0 && charset > 0);
  assert.ok(guard < charset, 'the null check must come first');
});

test('the CLI attach response tells an agent the branch is pending', () => {
  const src = read('src/routes/cli-agent.js');
  assert.match(src, /branch: session\.branch_name \|\| null/);
  assert.match(src, /branchPending: !session\.branch_name/);
});

test('the connector refuses to continue a session that has not run a turn', () => {
  const src = read('src/services/external-agent-tasks.js');
  assert.match(src, /fail\(\s*'session_not_started'/);
  const flow = read('src/routes/dev-flow.js');
  assert.match(flow, /session_not_started: 409/,
    'the code must be mapped, or dev-flow.js answers 500');
});

test('a staging build refuses a branchless session instead of cloning origin/null', () => {
  const src = read('src/services/staging.js');
  assert.match(src, /!viaPullRef && !session\.branch_name/);
  assert.match(src, /no branch yet/i);
});

// ── the hand-off copy ───────────────────────────────────────────────────

test('the launchpad prefill has a resume shape and a start shape', () => {
  const Launchpad = require('./lib/launchpad');
  const base = { slug: 'my-app', sessionTitle: 'Make the header sticky' };

  const fresh = Launchpad.prefillText({ ...base, targetKind: 'new' });
  assert.match(fresh, /Create a proposal for the Homeroom app `my-app`/);
  assert.equal(/proposalId/.test(fresh), false, 'new work has no proposal to continue');

  const resume = Launchpad.prefillText({
    ...base, targetKind: 'session', targetId: 812, branchName: 'dev/evan-1787',
  });
  assert.match(resume, /Continue work already started/);
  assert.match(resume, /Continue session #812/);
  assert.match(resume, /dev\/evan-1787/);
  // The three things an agent gets wrong without being told.
  assert.match(resume, /Do not start over/);
  assert.match(resume, /current head of that branch/);
  assert.match(resume, /Preserve the existing work/);
});

test('the resume prefill never tells an agent to push to the platform branch', () => {
  // The local agent follows the repository's proposal workflow for uploads;
  // the prompt must not suggest a direct push to a managed platform ref.
  const Launchpad = require('./lib/launchpad');
  const resume = Launchpad.prefillText({
    slug: 'my-app', targetKind: 'session', targetId: 812, branchName: 'dev/evan-1787',
  });
  assert.equal(
    /push (?:to|onto) (?:that|this) same branch/i.test(resume), false,
    'the proposal workflow controls updates to the managed session branch'
  );
});

test('a proposal continuation warns that the votes clear', () => {
  const Launchpad = require('./lib/launchpad');
  const out = Launchpad.prefillText({
    slug: 'my-app', targetKind: 'proposal', targetId: 900, branchName: 'dev/evan-1',
  });
  assert.match(out, /existing proposal/);
  assert.match(out, /re-review/);
});

test('the resume banner names the branch, and the new-work banner does not invent one', () => {
  const Launchpad = require('./lib/launchpad');
  const cont = Launchpad.resumeBannerHtml({
    targetKind: 'session', targetId: 5, branchName: 'dev/evan-1',
  });
  assert.match(cont, /data-launchpad-resume="continue"/);
  assert.match(cont, /<code>dev\/evan-1<\/code>/);

  const fresh = Launchpad.resumeBannerHtml({ targetKind: 'new' });
  assert.match(fresh, /data-launchpad-resume="new"/);
  assert.match(fresh, /nothing to resume/);
  assert.equal(/<code>/.test(fresh), false);
});

test('the resume banner escapes the branch name', () => {
  const Launchpad = require('./lib/launchpad');
  const out = Launchpad.resumeBannerHtml({
    targetKind: 'session', targetId: 5, branchName: 'dev/<img src=x>-1',
  });
  assert.equal(/<img/.test(out), false);
  assert.match(out, /&lt;img/);
});

test('a claimed continuation with no branch falls back to the start copy', () => {
  // Belt and braces: webTargetKind already requires hasBranch for
  // 'session', but the launchpad is rendered from a session row that a
  // poll can replace, and the failure mode is instructions to continue a
  // branch that does not exist.
  const Launchpad = require('./lib/launchpad');
  for (const state of [
    { targetKind: 'session', targetId: 5, branchName: null },
    { targetKind: 'session', targetId: 5, branchName: '   ' },
    { targetKind: 'session', targetId: null, branchName: 'dev/evan-1' },
  ]) {
    const out = Launchpad.prefillText({ slug: 'a', ...state });
    assert.match(out, /Create a proposal for the Homeroom app/, JSON.stringify(state));
    assert.equal(Launchpad.resumeBannerHtml(state), '', 'no banner without both facts');
  }
});

test('both hand-off launchpads render the banner from the same function', () => {
  const src = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.match(src, /_launchpadResumeState\(\)/);
  assert.match(src, /Launchpad\.resumeBannerHtml\(resume\) \+ DevFlowSelect\.wizardHtml\(/);
  const own = src.match(/_ownToolsGuideView\(\)\s*\{[\s\S]*?\n  \},/)[0];
  assert.match(own, /\.\.\.resume/);
  assert.match(own, /resumeHtml: Launchpad\.resumeBannerHtml\(resume\)/);
});

test('the local-CLI card drops "same branch" when there is no branch', () => {
  const SessionOptions = require('../public/js/session-options.js');
  const withBranch = SessionOptions.leadHtml({ hasBranch: true });
  assert.match(withBranch, /same branch/);

  const without = SessionOptions.leadHtml({ hasBranch: false });
  assert.equal(/same branch/.test(without), false);
  assert.match(without, /no branch on GitHub/);
  assert.match(without, /creates one when the first turn pushes/);
});

// ── the fixture ─────────────────────────────────────────────────────────

test('staging seeds a branchless session, and it is the only branchless fixture', () => {
  const src = read('src/db/migrate.js');
  assert.match(src, /const STAGING_NO_BRANCH_SESSION_ID = 990411;/);
  assert.match(src, /async function seedStagingNoBranchSession\(/);
  assert.match(src, /await seedStagingNoBranchSession\(pool, config\);/,
    'the seeder must be wired into the boot sequence');

  const fn = src.slice(src.indexOf('async function seedStagingNoBranchSession('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /USERNODE_ENV !== 'staging'/, 'must be a strict no-op in production');
  assert.match(body, /ON CONFLICT \(id\) DO UPDATE/, 'staging containers rebuild on every push');
  assert.match(body, /\[staging fixture\]/, 'seeded rows must be obviously fake');
});

test('the deep links for both banner states are declared as checks', () => {
  const dapp = JSON.parse(read('dapp.json'));
  const paths = (dapp.tests || []).map((t) => String(t.path || ''));
  assert.ok(
    paths.some((p) => p.includes('/dev/sessions/990411')),
    'the branchless fixture needs a check, or nothing renders that state'
  );
  const resume = (dapp.tests || []).filter((t) =>
    String(t.expectSelector || '').includes('data-launchpad-resume'));
  assert.ok(resume.length >= 2, 'both banner states must be checked');
  for (const t of resume) {
    assert.match(t.path, /^\/\?shot=launchpad&venue=/,
      'the banner is only reachable through the launchpad shot link');
  }
});

// ── the copy rule ───────────────────────────────────────────────────────

test('none of the new user-facing copy contains an em dash', () => {
  const Launchpad = require('./lib/launchpad');
  const SessionOptions = require('../public/js/session-options.js');
  const strings = [
    Launchpad.prefillText({ slug: 'a', targetKind: 'new' }),
    Launchpad.prefillText({ slug: 'a', targetKind: 'session', targetId: 1, branchName: 'dev/x-1' }),
    Launchpad.prefillText({ slug: 'a', targetKind: 'proposal', targetId: 1, branchName: 'dev/x-1' }),
    Launchpad.resumeBannerHtml({ targetKind: 'new' }),
    Launchpad.resumeBannerHtml({ targetKind: 'session', targetId: 1, branchName: 'dev/x-1' }),
    SessionOptions.leadHtml({ hasBranch: false }),
    SessionOptions.leadHtml({ hasBranch: true }),
  ];
  for (const s of strings) {
    for (const dash of ['—', '&mdash;', '&#8212;']) {
      assert.equal(s.includes(dash), false, `em dash in: ${s.slice(0, 60)}`);
    }
  }
});

test('the null-branch error messages read as instructions, not as diagnostics', () => {
  // Every one of these reaches a user, and each has exactly one useful
  // remedy: send a message. Saying so is the difference between a dead end
  // and a two-second fix.
  const worker = read('src/services/worker.js');
  const staging = read('src/services/staging.js');
  const sessions = read('src/routes/sessions.js');
  for (const src of [worker, staging, sessions]) {
    assert.equal(/—/.test(src.match(/Send a message in the session[^']*/)?.[0] || ''), false);
  }
  assert.match(worker, /Send a message in the session first/);
  assert.match(staging, /Send a message in the session first/);
});
