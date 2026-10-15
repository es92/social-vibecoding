// Tests for src/services/issue-close-watcher.js (#135) — the post-merge
// poll that waits for GitHub's own `Closes #N` auto-close to land, then
// busts the open-issues cache + broadcasts so the group-chat panel drops
// the issue.
//
// Covers the guarantees the merge path depends on:
//   1. Issues GitHub already closed are confirmed on the first poll and
//      trigger exactly one cache bust + broadcast.
//   2. Issues that close a few polls in are retried with backoff and the
//      broadcast fires once the closed state is observed.
//   3. The watcher never closes a number the session did not link, and
//      closes nothing while GitHub is still expected to (inside the polls).
//   4. Exhausted retries report stillOpen, no broadcast, never throw.
//   8. When the polls run out, the watcher closes the LINKED issues GitHub
//      left open — only for a PR merged into its repo's default branch —
//      keeps them hidden, and falls back to un-hiding when a close fails.
//   5. PR-shaped references and 404s are dropped from the watch.
//   6. Issue numbers come from the merged PR body's closing keywords
//      unioned with the session's linked_issues (getPR failure falls back
//      to linked_issues alone).
//   7. Transient state-check errors keep the issue in the watch.
//
// Like the other suites we stub collaborators via require.cache so no
// real GitHub calls happen.
//
// Run with: node --test tests/issue-close-watcher.test.js

// Zero all delays before the unit under test loads its tunables.
process.env.ISSUE_CLOSE_WATCH_GRACE_MS = '0';
process.env.ISSUE_CLOSE_WATCH_BACKOFF_MS = '0';
process.env.ISSUE_CLOSE_WATCH_ATTEMPTS = '3';

const test = require('node:test');
const assert = require('node:assert/strict');

// Install module stubs before requiring the unit under test.
// `gh` lets each test script the GitHub surface; `calls` records every
// call for assertions; `ws` records broadcast pushes.
function loadWithStubs({ gh = {}, calls, ws, issuesRoute = null, closedRequests = null }) {
  const ghPath = require.resolve('../src/services/github');
  const wsPath = require.resolve('../src/services/ws');
  const issuesPath = require.resolve('../src/routes/issues');
  const closedPath = require.resolve('../src/services/homeroom-bot-closed-requests');
  const subjectPath = require.resolve('../src/services/issue-close-watcher');
  const prMetaPath = require.resolve('../src/services/pr-metadata');
  const orig = {
    gh: require.cache[ghPath],
    ws: require.cache[wsPath],
    subject: require.cache[subjectPath],
    prMeta: require.cache[prMetaPath],
    issues: require.cache[issuesPath],
    closed: require.cache[closedPath],
  };

  require.cache[ghPath] = {
    exports: {
      isEnabled: () => true,
      getPR: async (owner, repo, prNumber) => {
        calls.push({ type: 'getPR', owner, repo, prNumber });
        if (gh.getPR) return gh.getPR(owner, repo, prNumber);
        return { body: '' };
      },
      getIssue: async (owner, repo, issueNumber) => {
        calls.push({ type: 'getIssue', owner, repo, issueNumber });
        if (gh.getIssue) return gh.getIssue(owner, repo, issueNumber);
        return { number: issueNumber, state: 'closed' };
      },
      // Recorded so tests can assert exactly which numbers get closed.
      closeIssue: async (owner, repo, issueNumber) => {
        calls.push({ type: 'closeIssue', owner, repo, issueNumber });
        if (gh.closeIssue) return gh.closeIssue(owner, repo, issueNumber);
        return { number: issueNumber, state: 'closed' };
      },
      invalidateIssuesCache: (owner, repo) => {
        calls.push({ type: 'invalidateIssuesCache', owner, repo });
      },
      // #144: known-closed suppression hooks the watcher drives.
      noteIssuesClosed: (owner, repo, numbers) => {
        calls.push({ type: 'noteIssuesClosed', owner, repo, numbers: [...numbers] });
        return numbers.length;
      },
      unsuppressIssues: (owner, repo, numbers) => {
        calls.push({ type: 'unsuppressIssues', owner, repo, numbers: [...numbers] });
        return numbers.length;
      },
      ...gh.overrides,
    },
    loaded: true, id: ghPath, filename: ghPath, paths: orig.gh ? orig.gh.paths : [],
  };
  require.cache[wsPath] = {
    exports: {
      pushIssueUpdate: (payload) => { ws.push(payload); },
    },
    loaded: true, id: wsPath, filename: wsPath, paths: orig.ws ? orig.ws.paths : [],
  };
  // With a pool the watcher lazy-requires routes/issues for the superseded
  // close-proposal resolve; tests that pass one stub it here.
  if (issuesRoute) {
    require.cache[issuesPath] = {
      exports: issuesRoute,
      loaded: true, id: issuesPath, filename: issuesPath, paths: orig.issues ? orig.issues.paths : [],
    };
  }
  // And the Homeroom bot's proposals for the closed requests.
  if (closedRequests) {
    require.cache[closedPath] = {
      exports: closedRequests,
      loaded: true, id: closedPath, filename: closedPath, paths: orig.closed ? orig.closed.paths : [],
    };
  }
  // pr-metadata requires ./llm and ./github at load time; with github
  // stubbed above a fresh load is safe and gives us the real
  // parseClosingKeywords/sanitizeIssueNumbers (which we want exercised).
  delete require.cache[prMetaPath];
  delete require.cache[subjectPath];
  const subject = require('../src/services/issue-close-watcher');

  const restore = () => {
    if (orig.gh) require.cache[ghPath] = orig.gh; else delete require.cache[ghPath];
    if (orig.ws) require.cache[wsPath] = orig.ws; else delete require.cache[wsPath];
    if (issuesRoute) {
      if (orig.issues) require.cache[issuesPath] = orig.issues; else delete require.cache[issuesPath];
    }
    if (closedRequests) {
      if (orig.closed) require.cache[closedPath] = orig.closed; else delete require.cache[closedPath];
    }
    delete require.cache[prMetaPath];
    if (orig.prMeta) require.cache[prMetaPath] = orig.prMeta;
    delete require.cache[subjectPath];
    if (orig.subject) require.cache[subjectPath] = orig.subject;
  };
  return { subject, restore };
}

const BASE_ARGS = {
  owner: 'usernode-bot', repo: 'some-app', prNumber: 42,
  appSlug: 'some-app', appId: 7,
};

test('confirms already-closed issues on the first poll and broadcasts once', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: { getPR: async () => ({ body: 'Fix things\n\nCloses #3\nfixes #9' }) },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS });
    assert.deepEqual(res.closed, [3, 9]);
    assert.deepEqual(res.stillOpen, []);
    assert.equal(calls.filter((c) => c.type === 'invalidateIssuesCache').length, 1);
    // #144: suppressed optimistically up front, re-suppressed on the
    // observed close, and nothing unsuppressed (everything DID close).
    const noted = calls.filter((c) => c.type === 'noteIssuesClosed');
    assert.deepEqual(noted[0].numbers, [3, 9]);
    assert.deepEqual(noted[noted.length - 1].numbers, [3, 9]);
    assert.equal(calls.filter((c) => c.type === 'unsuppressIssues').length, 0);
    assert.equal(ws.length, 1);
    assert.equal(ws[0].source, 'issue_close_watcher');
    assert.equal(ws[0].appSlug, 'some-app');
    // One poll round was enough — no extra getIssue calls.
    assert.equal(calls.filter((c) => c.type === 'getIssue').length, 2);
  } finally { restore(); }
});

test('keeps polling until GitHub reports closed, then broadcasts', async () => {
  const calls = [], ws = [];
  let polls = 0;
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => ({ body: 'Closes #4' }),
      getIssue: async (o, r, n) => {
        polls++;
        // GitHub's delayed auto-close lands on the third poll.
        return { number: n, state: polls < 3 ? 'open' : 'closed' };
      },
    },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS });
    assert.equal(polls, 3);
    assert.deepEqual(res.closed, [4]);
    assert.deepEqual(res.stillOpen, []);
    assert.equal(ws.length, 1);
  } finally { restore(); }
});

test('never closes a number only the PR body names', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => ({ body: 'Closes #5' }),
      getIssue: async (o, r, n) => ({ number: n, state: 'open' }),
    },
  });
  try {
    await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS });
    assert.equal(calls.filter((c) => c.type === 'closeIssue').length, 0);
  } finally { restore(); }
});

test('reports stillOpen after exhausting attempts, no broadcast, never throws', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => ({ body: 'Closes #8' }),
      getIssue: async (o, r, n) => ({ number: n, state: 'open' }),
    },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS });
    assert.deepEqual(res.stillOpen, [8]);
    assert.deepEqual(res.closed, []);
    // ISSUE_CLOSE_WATCH_ATTEMPTS=3 poll rounds, one issue each.
    assert.equal(calls.filter((c) => c.type === 'getIssue').length, 3);
    assert.equal(ws.length, 0);
    assert.equal(calls.filter((c) => c.type === 'invalidateIssuesCache').length, 0);
    // #144: the optimistic suppression is lifted for a genuinely-open
    // issue so it isn't hidden from the panel for the suppression TTL.
    const unsup = calls.filter((c) => c.type === 'unsuppressIssues');
    assert.equal(unsup.length, 1);
    assert.deepEqual(unsup[0].numbers, [8]);
  } finally { restore(); }
});

test('drops PR-shaped references and 404s from the watch', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => ({ body: 'Closes #2, fixes #6' }),
      getIssue: async (o, r, n) => {
        if (n === 2) return { number: 2, state: 'open', pull_request: { url: 'x' } };
        const e = new Error('Not Found'); e.status = 404; throw e;
      },
    },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS });
    assert.deepEqual(res.skipped.sort(), [2, 6]);
    assert.deepEqual(res.stillOpen, []);
    assert.equal(ws.length, 0);
    // Both dropped in round one — no further polling.
    assert.equal(calls.filter((c) => c.type === 'getIssue').length, 2);
  } finally { restore(); }
});

test('transient state-check errors keep the issue in the watch', async () => {
  const calls = [], ws = [];
  let polls = 0;
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => ({ body: 'Closes #7' }),
      getIssue: async (o, r, n) => {
        polls++;
        if (polls === 1) { const e = new Error('boom'); e.status = 502; throw e; }
        return { number: n, state: 'closed' };
      },
    },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS });
    assert.equal(polls, 2);
    assert.deepEqual(res.closed, [7]);
    assert.equal(ws.length, 1);
  } finally { restore(); }
});

test('unions PR-body keywords with linked_issues; falls back when getPR fails', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: { getPR: async () => ({ body: 'Resolves #10' }) },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({
      ...BASE_ARGS, linkedIssues: [10, 12, 'junk', -3],
    });
    assert.deepEqual(res.closed, [10, 12]);
  } finally { restore(); }

  const calls2 = [], ws2 = [];
  const { subject: subject2, restore: restore2 } = loadWithStubs({
    calls: calls2, ws: ws2,
    gh: { getPR: async () => { throw new Error('rate limited'); } },
  });
  try {
    const res = await subject2.watchIssuesClosedAfterMerge({
      ...BASE_ARGS, linkedIssues: [15],
    });
    assert.deepEqual(res.closed, [15]);
  } finally { restore2(); }
});

test('no-ops cleanly when GitHub is disabled or nothing is referenced', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: { overrides: { isEnabled: () => false } },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS });
    assert.deepEqual(res, { closed: [], skipped: [], stillOpen: [] });
    assert.equal(calls.length, 0);
  } finally { restore(); }

  const calls2 = [], ws2 = [];
  const { subject: subject2, restore: restore2 } = loadWithStubs({
    calls: calls2, ws: ws2,
    gh: { getPR: async () => ({ body: 'No keywords here' }) },
  });
  try {
    const res = await subject2.watchIssuesClosedAfterMerge({ ...BASE_ARGS, linkedIssues: [] });
    assert.deepEqual(res.closed, []);
    assert.equal(calls2.filter((c) => c.type === 'getIssue').length, 0);
    assert.equal(ws2.length, 0);
  } finally { restore2(); }
});

// A PR as GitHub returns it once merged into the app repo's default branch.
function mergedPr(body, over = {}) {
  return {
    body,
    merged: true,
    base: { ref: 'main', repo: { full_name: 'usernode-bot/some-app', default_branch: 'main' } },
    ...over,
  };
}

test('closes the linked issues GitHub left open, skips closed and unlinked ones', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      // #20 is only in the body; #10 and #11 are linked.
      getPR: async () => mergedPr('Closes #10\nCloses #11\nfixes #20'),
      getIssue: async (o, r, n) => ({ number: n, state: n === 11 ? 'closed' : 'open' }),
    },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS, linkedIssues: [10, 11] });
    const closes = calls.filter((c) => c.type === 'closeIssue');
    assert.deepEqual(closes.map((c) => c.issueNumber), [10], 'only the still-open linked issue');
    assert.equal(closes[0].owner, 'usernode-bot');
    assert.equal(closes[0].repo, 'some-app');
    // Closing happens only after every poll round ran.
    const firstClose = calls.findIndex((c) => c.type === 'closeIssue');
    assert.equal(calls.slice(0, firstClose).filter((c) => c.type === 'getIssue').length, 1 + 3 * 2);
    assert.deepEqual(res.closed.sort((a, b) => a - b), [10, 11]);
    assert.deepEqual(res.stillOpen, [20]);
    // #10 stays hidden (noted closed again, not unsuppressed); #20 is un-hidden.
    const noted = calls.filter((c) => c.type === 'noteIssuesClosed');
    assert.deepEqual(noted[noted.length - 1].numbers, [10]);
    const unsup = calls.filter((c) => c.type === 'unsuppressIssues');
    assert.deepEqual(unsup.map((c) => c.numbers), [[20]]);
    assert.equal(ws.length, 2, 'one refresh for #11 observed, one for #10 closed');
  } finally { restore(); }
});

test('a failed GitHub close falls back to un-hiding the issue', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => mergedPr('Closes #10\nCloses #12'),
      getIssue: async (o, r, n) => ({ number: n, state: 'open' }),
      closeIssue: async (o, r, n) => {
        if (n === 12) { const e = new Error('Forbidden'); e.status = 403; throw e; }
        return { number: n, state: 'closed' };
      },
    },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS, linkedIssues: [10, 12] });
    assert.deepEqual(res.closed, [10]);
    assert.deepEqual(res.stillOpen, [12]);
    const unsup = calls.filter((c) => c.type === 'unsuppressIssues');
    assert.deepEqual(unsup.map((c) => c.numbers), [[12]]);
  } finally { restore(); }
});

test('closes nothing unless the PR reads as merged into its own default branch', async () => {
  const cases = [
    ['PR fetch failed', async () => { throw new Error('rate limited'); }],
    ['not merged', async () => mergedPr('Closes #10', { merged: false })],
    ['other base branch', async () => mergedPr('Closes #10', {
      base: { ref: 'staging', repo: { full_name: 'usernode-bot/some-app', default_branch: 'main' } },
    })],
    ['other repository', async () => mergedPr('Closes #10', {
      base: { ref: 'main', repo: { full_name: 'someone/else', default_branch: 'main' } },
    })],
  ];
  for (const [label, getPR] of cases) {
    const calls = [], ws = [];
    const { subject, restore } = loadWithStubs({
      calls, ws,
      gh: { getPR, getIssue: async (o, r, n) => ({ number: n, state: 'open' }) },
    });
    try {
      const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS, linkedIssues: [10] });
      assert.equal(calls.filter((c) => c.type === 'closeIssue').length, 0, label);
      assert.deepEqual(res.stillOpen, [10], label);
      assert.deepEqual(calls.filter((c) => c.type === 'unsuppressIssues').map((c) => c.numbers), [[10]], label);
    } finally { restore(); }
  }
});

test('mergedIntoDefaultBranch tolerates a .git suffix and case', () => {
  const { subject, restore } = loadWithStubs({ calls: [], ws: [] });
  try {
    assert.equal(subject.mergedIntoDefaultBranch(mergedPr(''), 'Usernode-Bot', 'some-app.git'), true);
    assert.equal(subject.mergedIntoDefaultBranch(null, 'usernode-bot', 'some-app'), false);
    assert.equal(subject.mergedIntoDefaultBranch({ merged: true }, 'usernode-bot', 'some-app'), false);
  } finally { restore(); }
});

// ── The request's own twin row ──────────────────────────────────────────
//
// A platform-filed request keeps a `general` row in `issues` beside its
// GitHub issue (services/governance-kinds.js). Before this, only an applied
// close-issue vote closed it, so a request a merged proposal closed kept an
// open twin for good: Plant Pal's #1 still read open after PR #2 closed it.

// A pool that records every statement; `fail` makes the twin UPDATE reject.
function recordingPool({ fail = false } = {}) {
  const queries = [];
  return {
    queries,
    twinCloses: () => queries.filter((q) => /UPDATE issues SET status = 'closed'/.test(q.sql)),
    async query(sql, params) {
      queries.push({ sql, params });
      if (fail && /UPDATE issues/.test(sql)) throw new Error('db down');
      return { rows: [], rowCount: 0 };
    },
  };
}

const ISSUES_ROUTE_STUB = { resolveSupersededCloseProposals: async () => ({ resolved: [] }) };
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('an observed close closes the open general twins of those numbers on that app', async () => {
  const calls = [], ws = [];
  const pool = recordingPool();
  const { subject, restore } = loadWithStubs({
    calls, ws, issuesRoute: ISSUES_ROUTE_STUB,
    gh: { getPR: async () => ({ body: 'Closes #3\nfixes #9' }) },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS, pool });
    await settle();
    assert.deepEqual(res.closed, [3, 9]);
    const updates = pool.twinCloses();
    assert.equal(updates.length, 1);
    // Only the request's own twin, only while it still reads open, only on this app.
    assert.match(updates[0].sql, /kind = 'general'/);
    assert.match(updates[0].sql, /status = 'open'/);
    assert.match(updates[0].sql, /app_id = \$1/);
    assert.deepEqual(updates[0].params, [7, [3, 9]]);
  } finally { restore(); }
});

test('a linked issue the watcher closes itself closes its twin; one still open does not', async () => {
  const calls = [], ws = [];
  const pool = recordingPool();
  const { subject, restore } = loadWithStubs({
    calls, ws, issuesRoute: ISSUES_ROUTE_STUB,
    gh: {
      // #20 is only in the body, so it is watched but never closed here.
      getPR: async () => mergedPr('Closes #10\nfixes #20'),
      getIssue: async (o, r, n) => ({ number: n, state: 'open' }),
    },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS, linkedIssues: [10], pool });
    await settle();
    assert.deepEqual(res.closed, [10]);
    assert.deepEqual(res.stillOpen, [20]);
    const closedNumbers = pool.twinCloses().flatMap((q) => q.params[1]);
    assert.deepEqual(closedNumbers, [10], 'a number GitHub still reports open keeps its twin open');
  } finally { restore(); }
});

test('nothing closes a twin while every referenced issue is still open', async () => {
  const calls = [], ws = [];
  const pool = recordingPool();
  const { subject, restore } = loadWithStubs({
    calls, ws, issuesRoute: ISSUES_ROUTE_STUB,
    gh: {
      getPR: async () => ({ body: 'Closes #5' }),
      getIssue: async (o, r, n) => ({ number: n, state: 'open' }),
    },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS, pool });
    await settle();
    assert.deepEqual(res.stillOpen, [5]);
    assert.equal(pool.twinCloses().length, 0);
  } finally { restore(); }
});

test('a failing twin close never breaks the watch', async () => {
  const calls = [], ws = [];
  const pool = recordingPool({ fail: true });
  const { subject, restore } = loadWithStubs({
    calls, ws, issuesRoute: ISSUES_ROUTE_STUB,
    gh: { getPR: async () => ({ body: 'Closes #3' }) },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS, pool });
    await settle();
    assert.deepEqual(res.closed, [3], 'the watch finished normally');
    assert.equal(pool.twinCloses().length, 1);
    assert.equal(ws.length, 1, 'the panel refresh still went out');
  } finally { restore(); }
});

// The merge-followups workflow machine runs the watch as durable work: a
// close it could not record must fail the work, which is then retried,
// instead of settling while the twin or the close proposal stays open.
test('strict: a failing twin close fails the watch, after its polls', async () => {
  const calls = [], ws = [];
  const pool = recordingPool({ fail: true });
  const { subject, restore } = loadWithStubs({
    calls, ws, issuesRoute: ISSUES_ROUTE_STUB,
    gh: { getPR: async () => ({ body: 'Closes #3' }) },
  });
  try {
    await assert.rejects(subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS, pool, strict: true }), /db down/);
    assert.equal(ws.length, 1, 'the close itself was still seen and broadcast');
  } finally { restore(); }
});

test('strict: a failing superseded-proposal resolve fails the watch, and is asked to throw', async () => {
  const calls = [], ws = [];
  const asked = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    issuesRoute: {
      resolveSupersededCloseProposals: async (pool, args) => {
        asked.push(args.strict);
        if (args.strict) throw new Error('db down');
        return { resolved: [] };
      },
    },
    gh: { getPR: async () => ({ body: 'Closes #3' }) },
  });
  try {
    await assert.rejects(subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS, pool: recordingPool(), strict: true }), /db down/);
    assert.deepEqual(asked, [true]);
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS, pool: recordingPool() });
    assert.deepEqual(res.closed, [3], 'without strict it is logged and the watch finishes, as before');
  } finally { restore(); }
});

// ── The Homeroom bot's proposals for the closed requests ────────────────
// A request a person's change shipped kept the bot's proposal for it up for
// a vote, and one of the bot's five slots on the project with it, for good
// (#4817, shipped by #4822 while the bot's #4819 stayed up). Every close the
// watcher sees, or makes, now asks for them to be withdrawn.

function recordingClosed({ fail = false } = {}) {
  const asked = [];
  return {
    asked,
    async noteRequestsClosed(pool, args) {
      asked.push({ appId: args.appId, closed: args.closed, strict: args.strict });
      if (fail && args.strict) throw new Error('db down');
      return { withdrawn: [] };
    },
  };
}

test('an observed close asks for the bot\'s proposals on those requests to be withdrawn', async () => {
  const calls = [], ws = [];
  const closed = recordingClosed();
  const { subject, restore } = loadWithStubs({
    calls, ws, issuesRoute: ISSUES_ROUTE_STUB, closedRequests: closed,
    gh: { getPR: async () => ({ body: 'Closes #3\nfixes #9' }) },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS, pool: recordingPool() });
    assert.deepEqual(res.closed, [3, 9]);
    assert.deepEqual(closed.asked, [{ appId: 7, closed: [3, 9], strict: false }]);
  } finally { restore(); }
});

test('a linked issue the watcher closes itself is asked about too; one still open is not', async () => {
  const calls = [], ws = [];
  const closed = recordingClosed();
  const { subject, restore } = loadWithStubs({
    calls, ws, issuesRoute: ISSUES_ROUTE_STUB, closedRequests: closed,
    gh: {
      getPR: async () => mergedPr('Closes #10\nfixes #20'),
      getIssue: async (o, r, n) => ({ number: n, state: 'open' }),
    },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS, linkedIssues: [10], pool: recordingPool() });
    assert.deepEqual(res.stillOpen, [20]);
    assert.deepEqual(closed.asked, [{ appId: 7, closed: [10], strict: false }]);
  } finally { restore(); }
});

test('nothing is withdrawn while every referenced issue is still open, or without a pool', async () => {
  const calls = [], ws = [];
  const closed = recordingClosed();
  const { subject, restore } = loadWithStubs({
    calls, ws, issuesRoute: ISSUES_ROUTE_STUB, closedRequests: closed,
    gh: {
      getPR: async () => ({ body: 'Closes #5' }),
      getIssue: async (o, r, n) => ({ number: n, state: n === 5 ? 'open' : 'closed' }),
    },
  });
  try {
    await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS, pool: recordingPool() });
    assert.deepEqual(closed.asked, [], 'still open');
    await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS, linkedIssues: [6] });
    assert.deepEqual(closed.asked, [], 'no pool, nothing to write with');
  } finally { restore(); }
});

test('strict: a failing withdrawal fails the watch; without strict it is logged and the watch finishes', async () => {
  const calls = [], ws = [];
  const closed = recordingClosed({ fail: true });
  const { subject, restore } = loadWithStubs({
    calls, ws, issuesRoute: ISSUES_ROUTE_STUB, closedRequests: closed,
    gh: { getPR: async () => ({ body: 'Closes #3' }) },
  });
  try {
    await assert.rejects(subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS, pool: recordingPool(), strict: true }), /db down/);
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS, pool: recordingPool() });
    assert.deepEqual(res.closed, [3]);
    assert.deepEqual(closed.asked.map((a) => a.strict), [true, false]);
  } finally { restore(); }
});
