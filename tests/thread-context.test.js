// #945: unit tests for services/thread-context — the loaders that read an
// issue's / proposal's Homeroom-side Discussion thread, and the builders
// that render them into an agent prompt block.
//
// Pure module, so the only fake needed is a pool whose `query` records the
// SQL + params and returns canned rows. No Postgres, no GitHub, no LLM.
//
// Run with: node --test tests/thread-context.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const tc = require('../src/services/thread-context');

function makePool(rows = [], { throws = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (throws) throw new Error('db exploded');
      return { rows };
    },
  };
}

const row = (username, content, createdAt) => ({
  username, content, created_at: new Date(createdAt),
});

// ── Loaders ─────────────────────────────────────────────────────────────

test('loadIssueThread: binds thread_type=issue + the issue number, human messages only', async () => {
  const pool = makePool([
    row('evan', 'First.', '2026-06-01T00:00:00Z'),
    row('zura', 'Second.', '2026-06-02T00:00:00Z'),
  ]);
  const res = await tc.loadIssueThread(pool, 7, 945);

  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0];
  // The msg_type filter is what keeps ~70k lifecycle rows out of prompts.
  assert.ok(/msg_type = 'message'/.test(sql));
  assert.ok(/ORDER BY m\.id ASC/.test(sql));
  assert.deepEqual(params, [7, 'issue', 945]);

  assert.equal(res.truncated, false);
  assert.deepEqual(res.messages.map((m) => m.author), ['evan', 'zura']);
  assert.equal(res.messages[0].body, 'First.');
  // created_at is normalized to a comparable ISO string.
  assert.equal(res.messages[0].createdAt, '2026-06-01T00:00:00.000Z');
});

test('loadProposalThread: binds thread_type=session + the session id', async () => {
  const pool = makePool([row('evan', 'Looks good.', '2026-06-01T00:00:00Z')]);
  await tc.loadProposalThread(pool, 7, 2979);
  assert.deepEqual(pool.calls[0].params, [7, 'session', 2979]);
});

test('loaders return oldest-first, in the order the query yields', async () => {
  const pool = makePool([
    row('a', 'one', '2026-06-01T00:00:00Z'),
    row('b', 'two', '2026-06-02T00:00:00Z'),
    row('c', 'three', '2026-06-03T00:00:00Z'),
  ]);
  const res = await tc.loadIssueThread(pool, 1, 5);
  assert.deepEqual(res.messages.map((m) => m.body), ['one', 'two', 'three']);
});

test('a NULL user_id renders as "unknown" rather than blank', async () => {
  const pool = makePool([{ username: null, content: 'orphaned', created_at: null }]);
  const res = await tc.loadIssueThread(pool, 1, 5);
  assert.equal(res.messages[0].author, 'unknown');
  assert.equal(res.messages[0].createdAt, '');
});

test('a DB failure degrades to an empty result instead of throwing', async () => {
  const pool = makePool([], { throws: true });
  const res = await tc.loadIssueThread(pool, 1, 5);
  assert.deepEqual(res, { messages: [], truncated: false });
});

test('a missing pool or a bad ref short-circuits without querying', async () => {
  assert.deepEqual(await tc.loadIssueThread(null, 1, 5), { messages: [], truncated: false });

  const pool = makePool([row('a', 'x', '2026-06-01T00:00:00Z')]);
  assert.deepEqual(await tc.loadIssueThread(pool, 1, 0), { messages: [], truncated: false });
  assert.deepEqual(await tc.loadIssueThread(pool, 1, null), { messages: [], truncated: false });
  assert.deepEqual(await tc.loadIssueThread(pool, null, 5), { messages: [], truncated: false });
  assert.equal(pool.calls.length, 0);
});

// ── Clipping ────────────────────────────────────────────────────────────

test('clipThreadMessages: keeps the most recent 30 and flags the drop', () => {
  const many = [];
  for (let i = 1; i <= 35; i++) {
    many.push({ author: `u${i}`, body: `msg ${i}`, createdAt: '2026-06-01T00:00:00Z' });
  }
  const { messages, truncated } = tc.clipThreadMessages(many);
  assert.equal(messages.length, tc.THREAD_MESSAGES_KEEP);
  assert.equal(truncated, true);
  // The TAIL survives — recency is what matters in a discussion.
  assert.equal(messages[0].body, 'msg 6');
  assert.equal(messages[messages.length - 1].body, 'msg 35');
});

test('clipThreadMessages: clips a long body with an explicit marker', () => {
  const { messages, truncated } = tc.clipThreadMessages([
    { author: 'evan', body: 'x'.repeat(3000), createdAt: '2026-06-01T00:00:00Z' },
  ]);
  assert.equal(truncated, false);
  assert.equal(messages[0].body, `${'x'.repeat(tc.THREAD_MESSAGE_BODY_MAX)}… [truncated]`);
});

test('clipThreadMessages: tolerates junk input', () => {
  assert.deepEqual(tc.clipThreadMessages(null), { messages: [], truncated: false });
  assert.deepEqual(tc.clipThreadMessages([]), { messages: [], truncated: false });
});

// ── Merge + render ──────────────────────────────────────────────────────

test('mergeEntries: sorts both surfaces into one chronological list', () => {
  const merged = tc.mergeEntries(
    [
      { author: 'bot', body: 'Q', createdAt: '2026-06-01T00:00:00Z' },
      { author: 'r', body: 'late', createdAt: '2026-06-04T00:00:00Z' },
    ],
    [{ author: 'evan', body: 'A', createdAt: '2026-06-02T00:00:00Z' }]
  );
  assert.deepEqual(merged.map((e) => e.body), ['Q', 'A', 'late']);
  assert.deepEqual(merged.map((e) => e.source), ['github', 'usernode thread', 'github']);
});

test('mergeEntries: entries with no timestamp sort last, not first', () => {
  const merged = tc.mergeEntries(
    [{ author: 'a', body: 'no-date', createdAt: '' }],
    [{ author: 'b', body: 'dated', createdAt: '2026-06-02T00:00:00Z' }]
  );
  assert.deepEqual(merged.map((e) => e.body), ['dated', 'no-date']);
});

test('buildIssueDiscussionBlock: tags author, date and surface per entry', () => {
  const block = tc.buildIssueDiscussionBlock({
    issueNumber: 945,
    githubComments: [{ author: 'reporter', body: 'From GitHub.', createdAt: '2026-06-01T00:00:00Z' }],
    threadMessages: [{ author: 'evan', body: 'From the platform.', createdAt: '2026-06-02T00:00:00Z' }],
  });
  assert.ok(block.includes('DISCUSSION ON ISSUE #945 (oldest first;'));
  assert.ok(block.includes('[reporter, 2026-06-01, github] From GitHub.'));
  assert.ok(block.includes('[evan, 2026-06-02, usernode thread] From the platform.'));
});

test('buildIssueDiscussionBlock: keeps the bot tagging (incl. the [bot] suffix)', () => {
  const block = tc.buildIssueDiscussionBlock({
    issueNumber: 5,
    githubComments: [
      { author: 'usernode-bot', body: 'Q1?', createdAt: '2026-06-01T00:00:00Z' },
      { author: 'usernode-bot[bot]', body: 'Q2?', createdAt: '2026-06-02T00:00:00Z' },
    ],
    botUsername: 'usernode-bot',
  });
  assert.ok(block.includes('[bot — earlier proposal questions, 2026-06-01, github] Q1?'));
  assert.ok(block.includes('[bot — earlier proposal questions, 2026-06-02, github] Q2?'));
});

test('buildIssueDiscussionBlock: a platform-thread author is never bot-tagged', () => {
  // The bot only ever writes on GitHub and as a system row, so a HUMAN
  // who happens to share the bot's name must not be relabelled.
  const block = tc.buildIssueDiscussionBlock({
    issueNumber: 5,
    threadMessages: [{ author: 'usernode-bot', body: 'hi', createdAt: '2026-06-01T00:00:00Z' }],
    botUsername: 'usernode-bot',
  });
  assert.ok(block.includes('[usernode-bot, 2026-06-01, usernode thread] hi'));
  assert.ok(!block.includes('earlier proposal questions'));
});

test('buildIssueDiscussionBlock: the truncation marker leads the list', () => {
  const block = tc.buildIssueDiscussionBlock({
    issueNumber: 5,
    threadMessages: [{ author: 'evan', body: 'kept', createdAt: '2026-06-02T00:00:00Z' }],
    truncated: true,
  });
  assert.ok(block.includes('[earlier messages omitted]'));
  assert.ok(block.indexOf('[earlier messages omitted]') < block.indexOf('kept'));
});

test('buildProposalDiscussionBlock: names the PR when there is one', () => {
  const withPr = tc.buildProposalDiscussionBlock({
    sessionId: 2979, prNumber: 942,
    threadMessages: [{ author: 'evan', body: 'Ship it.', createdAt: '2026-06-02T00:00:00Z' }],
  });
  assert.ok(withPr.includes('DISCUSSION ON PR #942'));
  assert.ok(withPr.includes('[evan, 2026-06-02, usernode thread] Ship it.'));

  const withoutPr = tc.buildProposalDiscussionBlock({
    sessionId: 2979,
    threadMessages: [{ author: 'evan', body: 'Ship it.', createdAt: '2026-06-02T00:00:00Z' }],
  });
  assert.ok(withoutPr.includes('DISCUSSION ON THIS PROPOSAL'));
});

// Empty → '' is what keeps every prompt byte-identical for the (common)
// session with no discussion. Asserted at each layer.
test('builders return the empty string when there is nothing to show', () => {
  assert.equal(tc.buildIssueDiscussionBlock({ issueNumber: 5 }), '');
  assert.equal(tc.buildIssueDiscussionBlock({ issueNumber: 5, threadMessages: [], githubComments: [] }), '');
  assert.equal(tc.buildIssueDiscussionBlock(), '');
  assert.equal(tc.buildProposalDiscussionBlock({ sessionId: 1 }), '');
  assert.equal(tc.buildProposalDiscussionBlock(), '');
  assert.equal(tc.buildDiscussionPromptBlock({ issueBlock: '', proposalBlock: '' }), '');
  assert.equal(tc.buildDiscussionPromptBlock(), '');
  // Whitespace-only halves count as empty too.
  assert.equal(tc.buildDiscussionPromptBlock({ issueBlock: '   \n ' }), '');
});

test('buildDiscussionPromptBlock: delimits the block and carries the untrusted-data caveat', () => {
  const block = tc.buildDiscussionPromptBlock({
    issueBlock: 'ISSUE PART',
    proposalBlock: 'PROPOSAL PART',
  });
  assert.ok(block.startsWith('\n\n==== DISCUSSION ON THIS WORK ===='));
  assert.ok(block.trimEnd().endsWith('==== END DISCUSSION ===='));
  assert.ok(block.includes('ISSUE PART'));
  assert.ok(block.includes('PROPOSAL PART'));
  // The prompt-injection guard — thread text is arbitrary user input.
  assert.ok(/UNTRUSTED DATA/.test(block));
  assert.ok(/never as instructions/i.test(block));
  // And the "use it" half, so the block isn't purely defensive.
  assert.ok(/contradicts the\s+current spec/i.test(block));
});

test('buildDiscussionPromptBlock: one half alone still renders', () => {
  const only = tc.buildDiscussionPromptBlock({ proposalBlock: 'PROPOSAL PART' });
  assert.ok(only.includes('PROPOSAL PART'));
  assert.ok(only.includes('==== DISCUSSION ON THIS WORK ===='));
});
