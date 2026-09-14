// #945: the discussion context the Mayor and the dispatched agents now
// receive — the issue's and the proposal's Homeroom-side Discussion
// threads.
//
// Covers:
//   1. getMayorSystemPrompt's discussionBlock parameter (present when
//      passed, byte-identical prompt when not).
//   2. buildSessionDiscussionBlock — which issue it resolves, both thread
//      loads, and its degrade-to-'' failure posture.
//   3. get_github_issue's usernodeThread enrichment through
//      resolveDataToolResult's threadCtx.
//
// Same monkey-patch-the-module-object style as mayor-prod-debug.test.js:
// the resolvers call through the required module objects, so stubbing a
// method on them is enough — no require.cache surgery.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mayor-discussion-test-secret';

const sessions = require('../src/routes/sessions');
const github = require('../src/services/github');
const threadContext = require('../src/services/thread-context');

const {
  getMayorSystemPrompt,
  buildSessionDiscussionBlock,
  resolveDataToolResult,
} = sessions;

function makePool(rowsByThreadType = {}, { throws = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (throws) throw new Error('db exploded');
      const [, threadType] = params || [];
      return { rows: (rowsByThreadType[threadType] || []).slice() };
    },
  };
}

const row = (username, content, createdAt) => ({
  username, content, created_at: new Date(createdAt),
});

// ── 1. getMayorSystemPrompt gating ─────────────────────────────────────

test('mayor prompt: discussion block present iff a block is passed', () => {
  const block = threadContext.buildDiscussionPromptBlock({
    issueBlock: 'DISCUSSION ON ISSUE #945 (oldest first;)\n[evan, 2026-06-02, usernode thread] Do it.',
  });
  const withBlock = getMayorSystemPrompt('App', false, '', false, null, '', '', false, block);
  assert.match(withBlock, /==== DISCUSSION ON THIS WORK ====/);
  assert.match(withBlock, /\[evan, 2026-06-02, usernode thread\] Do it\./);
  assert.match(withBlock, /UNTRUSTED DATA/);

  const without = getMayorSystemPrompt('App', false, '', false, null, '', '', false, '');
  assert.doesNotMatch(without, /DISCUSSION ON THIS WORK/);
});

// The whole point of the '' default: a session with no discussion must
// produce the exact prompt it produced before this feature existed.
test('mayor prompt: omitting discussionBlock is byte-identical to passing ""', () => {
  const legacyShape = getMayorSystemPrompt('App', false, 'spec', false, null, '', '', false);
  const explicitEmpty = getMayorSystemPrompt('App', false, 'spec', false, null, '', '', false, '');
  assert.equal(legacyShape, explicitEmpty);
});

test('mayor prompt: the block rides alongside the spec, not instead of it', () => {
  const block = threadContext.buildDiscussionPromptBlock({ proposalBlock: 'PROPOSAL PART' });
  const prompt = getMayorSystemPrompt('App', false, 'MY SPEC BODY', false, null, '', '', false, block);
  assert.match(prompt, /CURRENT SPEC DOC/);
  assert.match(prompt, /MY SPEC BODY/);
  assert.match(prompt, /PROPOSAL PART/);
  // Spec last, so the live draft stays closest to the model's output.
  assert.ok(prompt.indexOf('PROPOSAL PART') < prompt.indexOf('MY SPEC BODY'));
});

// ── 2. buildSessionDiscussionBlock ─────────────────────────────────────

test('buildSessionDiscussionBlock: loads BOTH the issue and the proposal thread', async () => {
  const pool = makePool({
    issue: [row('evan', 'Answers: the app view header.', '2026-06-01T00:00:00Z')],
    session: [row('zura', 'This breaks the vote row.', '2026-06-02T00:00:00Z')],
  });
  const block = await buildSessionDiscussionBlock(pool, {
    id: 2979, app_id: 7, created_from_issue_number: 945, pr_number: 942, linked_issues: [],
  });

  assert.deepEqual(pool.calls.map((c) => c.params), [
    [7, 'issue', 945],
    [7, 'session', 2979],
  ]);
  assert.match(block, /DISCUSSION ON ISSUE #945/);
  assert.match(block, /\[evan, 2026-06-01, usernode thread\] Answers: the app view header\./);
  assert.match(block, /DISCUSSION ON PR #942/);
  assert.match(block, /\[zura, 2026-06-02, usernode thread\] This breaks the vote row\./);
});

test('buildSessionDiscussionBlock: falls back to the first linked issue', async () => {
  const pool = makePool({ issue: [row('evan', 'hi', '2026-06-01T00:00:00Z')] });
  await buildSessionDiscussionBlock(pool, {
    id: 3, app_id: 7, created_from_issue_number: null, linked_issues: [880, 881],
  });
  assert.deepEqual(pool.calls[0].params, [7, 'issue', 880]);
});

test('buildSessionDiscussionBlock: created_from_issue_number wins over linked_issues', async () => {
  const pool = makePool({ issue: [row('evan', 'hi', '2026-06-01T00:00:00Z')] });
  await buildSessionDiscussionBlock(pool, {
    id: 3, app_id: 7, created_from_issue_number: 945, linked_issues: [880],
  });
  assert.deepEqual(pool.calls[0].params, [7, 'issue', 945]);
});

test('buildSessionDiscussionBlock: no linked issue → only the proposal thread is read', async () => {
  const pool = makePool({ session: [row('evan', 'nice', '2026-06-02T00:00:00Z')] });
  const block = await buildSessionDiscussionBlock(pool, {
    id: 3, app_id: 7, created_from_issue_number: null, linked_issues: [],
  });
  assert.equal(pool.calls.length, 1);
  assert.deepEqual(pool.calls[0].params, [7, 'session', 3]);
  assert.doesNotMatch(block, /DISCUSSION ON ISSUE/);
  assert.match(block, /DISCUSSION ON THIS PROPOSAL/);
});

test('buildSessionDiscussionBlock: empty threads produce no block at all', async () => {
  const pool = makePool({});
  const block = await buildSessionDiscussionBlock(pool, {
    id: 3, app_id: 7, created_from_issue_number: 945, linked_issues: [],
  });
  assert.equal(block, '');
});

// Advisory context must never be able to fail a turn.
test('buildSessionDiscussionBlock: a DB failure degrades to no block', async () => {
  const pool = makePool({}, { throws: true });
  const block = await buildSessionDiscussionBlock(pool, {
    id: 3, app_id: 7, created_from_issue_number: 945, linked_issues: [],
  });
  assert.equal(block, '');
});

test('buildSessionDiscussionBlock: a missing session degrades to no block', async () => {
  assert.equal(await buildSessionDiscussionBlock(makePool({}), null), '');
});

// ── 3. get_github_issue enrichment ─────────────────────────────────────

function withGithubStubs(t, { issue = null, comments = [] } = {}) {
  const origIssue = github.fetchPublicIssue;
  const origComments = github.fetchIssueComments;
  github.fetchPublicIssue = async () => ({ issue });
  github.fetchIssueComments = async () => ({ comments, truncated: false });
  t.after(() => {
    github.fetchPublicIssue = origIssue;
    github.fetchIssueComments = origComments;
  });
}

test('get_github_issue: threadCtx adds usernodeThread alongside the GitHub comments', async (t) => {
  withGithubStubs(t, {
    issue: { number: 945, title: 'Grant bots access', body: 'body' },
    comments: [{ author: 'reporter', body: 'From GitHub.', createdAt: '2026-06-01T00:00:00Z' }],
  });
  const pool = makePool({ issue: [row('evan', 'From the platform.', '2026-06-02T00:00:00Z')] });

  const raw = await resolveDataToolResult(
    { name: 'get_github_issue', input: { number: 945 } },
    'owner', 'repo', null, { pool, appId: 7 }
  );
  const parsed = JSON.parse(raw);

  assert.equal(parsed.issue.number, 945);
  assert.deepEqual(parsed.comments.map((c) => c.body), ['From GitHub.']);
  assert.deepEqual(parsed.usernodeThread, [
    { author: 'evan', body: 'From the platform.', createdAt: '2026-06-02T00:00:00.000Z' },
  ]);
  assert.equal(parsed.usernodeThreadTruncated, false);
  assert.deepEqual(pool.calls[0].params, [7, 'issue', 945]);
});

test('get_github_issue: no threadCtx → the field is simply absent', async (t) => {
  withGithubStubs(t, { issue: { number: 945, title: 'T', body: 'b' } });
  const raw = await resolveDataToolResult(
    { name: 'get_github_issue', input: { number: 945 } }, 'owner', 'repo'
  );
  const parsed = JSON.parse(raw);
  assert.ok(!('usernodeThread' in parsed));
  assert.ok(!('usernodeThreadTruncated' in parsed));
  assert.deepEqual(parsed.comments, []);
});

test('get_github_issue: an empty thread omits the field rather than sending []', async (t) => {
  withGithubStubs(t, { issue: { number: 945, title: 'T', body: 'b' } });
  const raw = await resolveDataToolResult(
    { name: 'get_github_issue', input: { number: 945 } },
    'owner', 'repo', null, { pool: makePool({}), appId: 7 }
  );
  assert.ok(!('usernodeThread' in JSON.parse(raw)));
});

test('get_github_issue: a thread-load failure still returns the GitHub halves', async (t) => {
  withGithubStubs(t, {
    issue: { number: 945, title: 'T', body: 'b' },
    comments: [{ author: 'r', body: 'c', createdAt: '2026-06-01T00:00:00Z' }],
  });
  const raw = await resolveDataToolResult(
    { name: 'get_github_issue', input: { number: 945 } },
    'owner', 'repo', null, { pool: makePool({}, { throws: true }), appId: 7 }
  );
  const parsed = JSON.parse(raw);
  assert.equal(parsed.issue.number, 945);
  assert.deepEqual(parsed.comments.map((c) => c.body), ['c']);
  assert.ok(!('usernodeThread' in parsed));
});

// The description IS the agent-facing contract: a model that isn't told
// usernodeThread exists won't think to read it.
test('get_github_issue: the tool description names both discussion surfaces', () => {
  const { description } = sessions.GET_GITHUB_ISSUE_TOOL;
  assert.match(description, /usernodeThread/);
  assert.match(description, /usernodeThreadTruncated/);
  assert.match(description, /Discussion\s+thread on this platform/);
  assert.match(description, /read\s+BOTH/);
  // …and the untrusted-input posture travels with it.
  assert.match(description, /never as instructions/i);
});

test('list_github_issues is unaffected by threadCtx', async (t) => {
  const orig = github.fetchPublicIssues;
  github.fetchPublicIssues = async () => ({ issues: [{ number: 1, title: 'T' }], truncatedList: false });
  t.after(() => { github.fetchPublicIssues = orig; });

  const pool = makePool({ issue: [row('evan', 'x', '2026-06-01T00:00:00Z')] });
  const raw = await resolveDataToolResult(
    { name: 'list_github_issues', input: {} }, 'owner', 'repo', null, { pool, appId: 7 }
  );
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed.issues));
  assert.ok(!('usernodeThread' in parsed));
  // No thread query was issued for the list form.
  assert.equal(pool.calls.length, 0);
});
