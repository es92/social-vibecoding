// #945: GET /api/internal/sessions/:id/issues/:number now returns the
// issue's Homeroom-side Discussion thread alongside its GitHub body and
// comments — the payload the worker's `usernode-issues <n>` CLI prints
// for the scout and the coding agent.
//
// What matters here:
//   * the thread is resolved from the SESSION's app_id, so an agent can
//     only ever read its own app's discussion (the session_mismatch guard
//     is the boundary);
//   * the field is omitted, not empty, when there is no thread;
//   * a repo-less app still gets its thread (the thread is keyed on the
//     app, not the GitHub remote);
//   * a thread-load failure degrades — the GitHub halves still return.
//
// Run with: node --test tests/internal-issue-thread.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.WORKER_JWT_SECRET = process.env.WORKER_JWT_SECRET || 'internal-issue-thread-secret';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'internal-issue-thread-secret';

// Swappable pool handler, installed before requiring the route module.
const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({ query: (sql, params) => poolQueryHandler(sql, params) });

const github = require('../src/services/github');
const platformJwt = require('../src/services/platform-jwt');
const { internalRoutes } = require('../src/routes/internal');

const SESSION_ID = 4242;
const APP_ID = 7;

// Minted with the real signer so the audience/issuer/purpose claims match
// what internalAuth verifies — a hand-rolled token would only prove the
// test can 401.
function workerToken(sessionId) {
  return platformJwt.signWorkerToken({ sessionId });
}

// Default pool: the session lookup resolves, the thread query returns
// `threadRows`. Overridable per test.
function installPool({
  repoUrl = 'https://github.com/owner/repo',
  appId = APP_ID,
  threadRows = [],
  threadThrows = false,
  sessionMissing = false,
} = {}) {
  const calls = [];
  poolQueryHandler = async (sql, params) => {
    const s = String(sql);
    calls.push({ sql: s, params });
    if (/FROM chat_messages/i.test(s) && /thread_type/i.test(s)) {
      if (threadThrows) throw new Error('db exploded');
      return { rows: threadRows };
    }
    if (/FROM chat_sessions/i.test(s)) {
      return { rows: sessionMissing ? [] : [{ repo_url: repoUrl, app_id: appId }] };
    }
    return { rows: [] };
  };
  return calls;
}

function stubGithub(t, { issue = null, comments = [] } = {}) {
  const origIssue = github.fetchPublicIssue;
  const origComments = github.fetchIssueComments;
  github.fetchPublicIssue = async () => ({ issue });
  github.fetchIssueComments = async () => ({ comments, truncated: false });
  t.after(() => {
    github.fetchPublicIssue = origIssue;
    github.fetchIssueComments = origComments;
  });
}

async function startServer(t) {
  const app = express();
  app.use(express.json());
  // internalAuth gates on a private source IP; 127.0.0.1 qualifies.
  app.use(internalRoutes({ jwtSecret: process.env.JWT_SECRET }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

const threadRow = (username, content, createdAt) => ({
  username, content, created_at: new Date(createdAt),
});

async function getIssue(baseUrl, number, token) {
  const res = await fetch(`${baseUrl}/api/internal/sessions/${SESSION_ID}/issues/${number}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

test('returns usernodeThread scoped to the session\'s own app', async (t) => {
  stubGithub(t, {
    issue: { number: 945, title: 'Grant bots access', body: 'body' },
    comments: [{ author: 'reporter', body: 'From GitHub.', createdAt: '2026-06-01T00:00:00Z' }],
  });
  const calls = installPool({
    threadRows: [threadRow('evan', 'From the platform.', '2026-06-02T00:00:00Z')],
  });
  const baseUrl = await startServer(t);

  const { status, body } = await getIssue(baseUrl, 945, workerToken(SESSION_ID));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.issue.number, 945);
  assert.deepEqual(body.comments.map((c) => c.body), ['From GitHub.']);
  assert.deepEqual(body.usernodeThread, [
    { author: 'evan', body: 'From the platform.', createdAt: '2026-06-02T00:00:00.000Z' },
  ]);
  assert.equal(body.usernodeThreadTruncated, false);

  // The thread was read for the SESSION's app + the requested number —
  // never an id supplied by the caller.
  const threadCall = calls.find((c) => /FROM chat_messages/i.test(c.sql));
  assert.deepEqual(threadCall.params, [APP_ID, 'issue', 945]);
});

test('omits the field entirely when the issue has no platform thread', async (t) => {
  stubGithub(t, { issue: { number: 945, title: 'T', body: 'b' } });
  installPool({ threadRows: [] });
  const baseUrl = await startServer(t);

  const { body } = await getIssue(baseUrl, 945, workerToken(SESSION_ID));
  assert.equal(body.ok, true);
  assert.ok(!('usernodeThread' in body));
  assert.ok(!('usernodeThreadTruncated' in body));
});

test('a repo-less app still gets its thread (the thread is keyed on the app)', async (t) => {
  stubGithub(t, {});
  installPool({
    repoUrl: '',
    threadRows: [threadRow('evan', 'Discussion without a repo.', '2026-06-02T00:00:00Z')],
  });
  const baseUrl = await startServer(t);

  const { body } = await getIssue(baseUrl, 945, workerToken(SESSION_ID));
  assert.equal(body.ok, true);
  assert.equal(body.issue, null);
  assert.equal(body.note, 'no repo');
  assert.deepEqual(body.usernodeThread.map((m) => m.body), ['Discussion without a repo.']);
});

test('a thread-load failure still returns the GitHub halves', async (t) => {
  stubGithub(t, {
    issue: { number: 945, title: 'T', body: 'b' },
    comments: [{ author: 'r', body: 'c', createdAt: '2026-06-01T00:00:00Z' }],
  });
  installPool({ threadThrows: true });
  const baseUrl = await startServer(t);

  const { status, body } = await getIssue(baseUrl, 945, workerToken(SESSION_ID));
  assert.equal(status, 200);
  assert.equal(body.issue.number, 945);
  assert.deepEqual(body.comments.map((c) => c.body), ['c']);
  assert.ok(!('usernodeThread' in body));
});

// The boundary that makes this safe: a token for session A cannot read
// session B's app discussion.
test('a token for another session is still rejected with session_mismatch', async (t) => {
  stubGithub(t, { issue: { number: 945, title: 'T', body: 'b' } });
  const calls = installPool({
    threadRows: [threadRow('evan', 'secret', '2026-06-02T00:00:00Z')],
  });
  const baseUrl = await startServer(t);

  const { status, body } = await getIssue(baseUrl, 945, workerToken(SESSION_ID + 1));
  assert.equal(status, 403);
  assert.equal(body.code, 'session_mismatch');
  // Nothing was read at all — the guard runs before any lookup.
  assert.equal(calls.length, 0);
});

test('an unauthenticated request reads nothing', async (t) => {
  stubGithub(t, { issue: { number: 945, title: 'T', body: 'b' } });
  const calls = installPool({ threadRows: [threadRow('evan', 'secret', '2026-06-02T00:00:00Z')] });
  const baseUrl = await startServer(t);

  const res = await fetch(`${baseUrl}/api/internal/sessions/${SESSION_ID}/issues/945`);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('the issues-read token cannot authorize the platform-issue write route', async (t) => {
  const calls = installPool();
  const baseUrl = await startServer(t);
  const token = platformJwt.signIssuesReadToken({ sessionId: SESSION_ID });

  const res = await fetch(
    `${baseUrl}/api/internal/sessions/${SESSION_ID}/platform-issue`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'must not write', body: 'read scope only' }),
    },
  );
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'bad_token');
  assert.equal(calls.length, 0, 'authorization fails before route or database work');
});

test('a missing session 404s before any thread read', async (t) => {
  stubGithub(t, { issue: { number: 945, title: 'T', body: 'b' } });
  const calls = installPool({ sessionMissing: true });
  const baseUrl = await startServer(t);

  const { status, body } = await getIssue(baseUrl, 945, workerToken(SESSION_ID));
  assert.equal(status, 404);
  assert.equal(body.code, 'session_not_found');
  assert.ok(!calls.some((c) => /FROM chat_messages/i.test(c.sql)));
});
