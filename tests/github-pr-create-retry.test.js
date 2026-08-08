// Tests for createPR's transient-failure hardening (2026-07-24 outage:
// GitHub answered every POST /pulls with an empty-body 500 for hours,
// which surfaced as a useless `{"err":""}` log and a misleading "re-run
// your request" user error).
//
// - 5xx / status-less network errors retry on an injectable schedule,
//   then throw a typed 'github_unavailable' error carrying the HTTP
//   status and GitHub request id.
// - The typed 422s (no_commits / pr_exists) are NEVER retried — they're
//   deterministic answers, and pr_exists specifically is how a
//   500-that-actually-created-the-PR heals on the next attempt.
// - describeGithubError produces a non-empty, log-safe shape even for
//   Octokit RequestErrors whose message is empty (empty response body).
//
// Run with: node --test tests/github-pr-create-retry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const github = require('../src/services/github');

function requestError(status, { message = '', body, requestId } = {}) {
  const err = new Error(message);
  if (status != null) err.status = status;
  err.response = {
    status,
    headers: requestId ? { 'x-github-request-id': requestId } : {},
    data: body,
  };
  return err;
}

// Builds a fake octokit whose pulls.create pops one behavior per call
// from `script`: either a function that throws, or an object returned as
// the created PR.
function scriptedOctokit(script, calls) {
  return {
    rest: {
      pulls: {
        create: async (params) => {
          calls.push(params);
          const step = script.shift();
          if (typeof step === 'function') return step();
          return { data: step };
        },
      },
    },
  };
}

function withScript(script, calls) {
  github._setOctokitFactoryForTests(() => scriptedOctokit(script, calls));
  github._setCreatePrRetryDelaysForTests([1, 1]); // no real sleeping
}

function cleanup() {
  github._setOctokitFactoryForTests(null);
  github._setCreatePrRetryDelaysForTests(null);
}

test('500 twice then success → resolves with the PR after retries', async () => {
  const calls = [];
  withScript([
    () => { throw requestError(500, { requestId: 'AB36:1' }); },
    () => { throw requestError(500, { requestId: 'AB36:2' }); },
    { number: 91, html_url: 'https://example/pr/91' },
  ], calls);
  try {
    const pr = await github.createPR('acme', 'app', { branch: 'feat/x', title: 't', body: 'b' });
    assert.equal(pr.number, 91);
    assert.equal(calls.length, 3, 'two retries after the two 500s');
  } finally {
    cleanup();
  }
});

test('500 on every attempt → typed github_unavailable with status + request id', async () => {
  const calls = [];
  withScript([
    () => { throw requestError(500, { requestId: 'AB36:X' }); },
    () => { throw requestError(500, { requestId: 'AB36:Y' }); },
    () => { throw requestError(500, { requestId: 'AB36:Z' }); },
  ], calls);
  try {
    await assert.rejects(
      github.createPR('acme', 'app', { branch: 'feat/x', title: 't', body: 'b' }),
      (err) => {
        assert.equal(err.code, 'github_unavailable');
        assert.equal(err.status, 500);
        assert.equal(err.requestId, 'AB36:Z');
        assert.match(err.message, /HTTP 500/);
        assert.match(err.message, /AB36:Z/);
        assert.match(err.message, /acme:feat\/x/);
        return true;
      }
    );
    assert.equal(calls.length, 3, 'all attempts consumed');
  } finally {
    cleanup();
  }
});

test('status-less network error is treated as transient and retried', async () => {
  const calls = [];
  withScript([
    () => { throw new Error('socket hang up'); },
    { number: 5, html_url: 'https://example/pr/5' },
  ], calls);
  try {
    const pr = await github.createPR('acme', 'app', { branch: 'feat/x', title: 't', body: 'b' });
    assert.equal(pr.number, 5);
    assert.equal(calls.length, 2);
  } finally {
    cleanup();
  }
});

test('500 then 422 "already exists" → pr_exists surfaces (the adopt path heals a half-created PR)', async () => {
  const calls = [];
  withScript([
    () => { throw requestError(500, {}); },
    () => { throw requestError(422, { message: 'Validation Failed: A pull request already exists for acme:feat/x.' }); },
  ], calls);
  try {
    await assert.rejects(
      github.createPR('acme', 'app', { branch: 'feat/x', title: 't', body: 'b' }),
      (err) => err.code === 'pr_exists'
    );
    assert.equal(calls.length, 2);
  } finally {
    cleanup();
  }
});

test('422 "No commits between" is thrown immediately — never retried', async () => {
  const calls = [];
  withScript([
    () => { throw requestError(422, { message: 'Validation Failed: No commits between main and feat/x' }); },
    { number: 99, html_url: 'https://example/pr/99' }, // must never be reached
  ], calls);
  try {
    await assert.rejects(
      github.createPR('acme', 'app', { branch: 'feat/x', title: 't', body: 'b' }),
      (err) => err.code === 'no_commits'
    );
    assert.equal(calls.length, 1, 'no retry on a deterministic 422');
  } finally {
    cleanup();
  }
});

test('a non-transient 4xx (e.g. 403) is neither retried nor re-typed', async () => {
  const calls = [];
  withScript([
    () => { throw requestError(403, { message: 'Resource not accessible by integration' }); },
  ], calls);
  try {
    await assert.rejects(
      github.createPR('acme', 'app', { branch: 'feat/x', title: 't', body: 'b' }),
      (err) => err.status === 403 && !err.code
    );
    assert.equal(calls.length, 1);
  } finally {
    cleanup();
  }
});

test('describeGithubError: empty-message empty-body 500 still describes itself', () => {
  const d = github.describeGithubError(requestError(500, { body: '', requestId: 'CD38:1' }));
  assert.equal(d.status, 500);
  assert.equal(d.requestId, 'CD38:1');
  assert.ok(d.message && d.message.length > 0, 'message is never empty');
  assert.match(d.message, /HTTP 500/);
});

test('describeGithubError: plain errors and nullish input are handled', () => {
  const plain = github.describeGithubError(new Error('boom'));
  assert.equal(plain.status, null);
  assert.equal(plain.message, 'boom');
  const none = github.describeGithubError(null);
  assert.ok(none.message);
});

test('describeGithubError: long string bodies are truncated for the log', () => {
  const d = github.describeGithubError(requestError(502, { body: 'x'.repeat(5000) }));
  assert.ok(d.data.length <= 300);
});

// ── #967: cross-fork head ──────────────────────────────────────────────
//
// The hosted MCP connector opens the pull request from a branch in the
// USER'S fork, so createPR grew an explicit `head`. The two properties that
// matter: an explicit head is passed through verbatim (GitHub needs the
// `owner:branch` form for a cross-repository PR), and every pre-existing
// caller — which passes only `branch` — is byte-for-byte unaffected.

test('an explicit head is passed to GitHub verbatim (cross-fork PR)', async () => {
  const calls = [];
  withScript([{ number: 12, html_url: 'https://example/pr/12' }], calls);
  try {
    const pr = await github.createPR('usernode-bot', 'recipe-box', {
      branch: 'usernode/recipe-box-issue-4-a1b2c3',
      head: 'someuser:usernode/recipe-box-issue-4-a1b2c3',
      title: 't',
      body: 'b',
    });
    assert.equal(pr.number, 12);
    assert.equal(calls[0].head, 'someuser:usernode/recipe-box-issue-4-a1b2c3');
    assert.equal(calls[0].owner, 'usernode-bot', 'the PR still targets the app repo');
    assert.equal(calls[0].base, 'main');
  } finally {
    cleanup();
  }
});

test('callers that pass only branch still send the bare branch as head', async () => {
  const calls = [];
  withScript([{ number: 13, html_url: 'https://example/pr/13' }], calls);
  try {
    await github.createPR('acme', 'app', { branch: 'feat/x', title: 't', body: 'b' });
    assert.equal(calls[0].head, 'feat/x', 'same-repo callers are unchanged');
  } finally {
    cleanup();
  }
});

test('a cross-fork no_commits error names the fork branch, not owner:branch', async () => {
  const calls = [];
  withScript([
    () => { throw requestError(422, { message: 'Validation Failed: No commits between main and someuser:feat/x' }); },
  ], calls);
  try {
    await assert.rejects(
      github.createPR('acme', 'app', { branch: 'feat/x', head: 'someuser:feat/x', title: 't', body: 'b' }),
      (err) => {
        assert.equal(err.code, 'no_commits');
        assert.match(err.message, /someuser:feat\/x/);
        return true;
      }
    );
  } finally {
    cleanup();
  }
});

// ── maintainer_can_modify on cross-fork creates ────────────────────────
//
// GitHub treats `maintainer_can_modify` as TRUE when the parameter is
// omitted. On a cross-fork head that is a request to grant the BASE
// repo's maintainers push access to the HEAD branch, which only a
// collaborator on the fork may grant — so GitHub 422s the whole create
// with `field: "fork_collab"`. That implicit default is why every
// cross-fork submission in production fell through to the mirror
// (task 3, request ids C73C:… and A1D8:…, 2026-08-07).
//
// These assert on the body the GITHUB CLIENT received, not on what the
// caller passed: createPR destructures a FIXED parameter list, so an
// extra key handed in by a caller is silently dropped unless the
// signature names it. That is the trap this pins.

test('a cross-fork create sends maintainer_can_modify: false to GitHub', async () => {
  const calls = [];
  withScript([{ number: 52, html_url: 'https://example/pr/52' }], calls);
  try {
    await github.createPR('usernode-bot', 'todo-list', {
      branch: 'usernode/x',
      head: 'es92:usernode/x',
      headRepo: 'es92/todo-list',
      maintainerCanModify: false,
      title: 't',
      body: 'b',
    });
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].maintainer_can_modify, false,
      'the parameter must reach the client body, not just the caller'
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(calls[0], 'maintainer_can_modify'),
      'sent as a real key rather than dropped by the destructure'
    );
  } finally {
    cleanup();
  }
});

test('a same-repo create sends no maintainer_can_modify key at all', async () => {
  const calls = [];
  withScript([{ number: 13, html_url: 'https://example/pr/13' }], calls);
  try {
    await github.createPR('acme', 'app', { branch: 'feat/x', title: 't', body: 'b' });
    assert.equal(
      Object.prototype.hasOwnProperty.call(calls[0], 'maintainer_can_modify'), false,
      'same-repo callers keep GitHub’s default — five working call sites stay untouched'
    );
  } finally {
    cleanup();
  }
});

test('maintainerCanModify: true is forwarded too — the check is boolean, not truthy', async () => {
  // `false` is the value that matters, so a truthy guard would drop the
  // whole feature. Pin that the guard is a typeof check by proving the
  // other boolean survives as well.
  const calls = [];
  withScript([{ number: 14, html_url: 'https://example/pr/14' }], calls);
  try {
    await github.createPR('acme', 'app', {
      branch: 'feat/x', title: 't', body: 'b', maintainerCanModify: true,
    });
    assert.equal(calls[0].maintainer_can_modify, true);
  } finally {
    cleanup();
  }
});

test('a fork_collab 422 becomes a typed, non-retried fork_collab_denied', async () => {
  // The exact payload production logged, verbatim.
  const calls = [];
  withScript([
    () => {
      throw requestError(422, {
        message: 'Validation Failed',
        requestId: 'A1D8:13D72D:10DA701:FFBFB5:6A763044',
        body: {
          message: 'Validation Failed',
          errors: [{
            resource: 'PullRequest',
            code: 'custom',
            field: 'fork_collab',
            message: "fork_collab Fork collab can't be granted by someone without permission",
          }],
        },
      });
    },
  ], calls);
  try {
    await assert.rejects(
      github.createPR('usernode-bot', 'todo-list', {
        branch: 'usernode/x', head: 'es92:usernode/x', title: 't', body: 'b',
      }),
      (err) => {
        assert.equal(err.code, 'fork_collab_denied');
        assert.equal(err.status, 422);
        assert.match(err.message, /maintainer/i, 'names the grant that was refused');
        assert.match(err.message, /es92:usernode\/x/, 'names the head it was opening');
        return true;
      }
    );
    assert.equal(calls.length, 1, 'a deterministic 422 is never retried');
  } finally {
    cleanup();
  }
});
