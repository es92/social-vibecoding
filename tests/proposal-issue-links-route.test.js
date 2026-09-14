'use strict';

// #2028 — an existing proposal's request associations are an ordinary,
// owner-scoped mutation. Exercise the real Express route so the browser and
// connector cannot drift on validation or authorization.

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
let session = null;
const queries = [];
poolMod.getPool = () => ({
  query: async (sql, params) => {
    const text = String(sql);
    queries.push({ sql: text, params });
    if (/SELECT a\.id, a\.collab_visibility/.test(text)) {
      return { rows: [{ id: 3, collab_visibility: 'public', view_visibility: 'public' }] };
    }
    if (/SELECT cs\.\*, a\.slug AS app_slug/.test(text)) {
      return { rows: session ? [session] : [] };
    }
    return { rows: [] };
  },
});

const proposalUpdate = require('../src/services/proposal-update');
const github = require('../src/services/github');
const ws = require('../src/services/ws');
const originals = {
  updateLinkedIssues: proposalUpdate.updateLinkedIssues,
  withProposalLock: proposalUpdate.withProposalLock,
  parseGithubUrl: github.parseGithubUrl,
  pushIssueUpdate: ws.pushIssueUpdate,
};
const { sessionRoutes } = require('../src/routes/sessions');

const OWNER = { id: 7, username: 'owner' };
const ADMIN = { id: 9, username: 'admin', isAdmin: true, canAdminWrite: true };
const PROPOSAL_ID = 412;
let updates = [];
let broadcasts = [];
let locks = [];

function row(over = {}) {
  return {
    id: PROPOSAL_ID,
    app_id: 3,
    app_slug: 'recipe-box',
    repo_url: 'https://github.com/acme/recipe-box',
    user_id: OWNER.id,
    linked_issues: [12, 18],
    source: 'native',
    pr_number: 41,
    ...over,
  };
}

function startServer(user = OWNER, { connector = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    if (connector) req.connectorClientId = 'chatgpt';
    next();
  });
  app.use(sessionRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function patch(server, body, id = PROPOSAL_ID) {
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/sessions/${id}/linked-issues`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  session = row();
  queries.length = 0;
  updates = [];
  broadcasts = [];
  locks = [];
  github.parseGithubUrl = () => ({ owner: 'acme', repo: 'recipe-box' });
  ws.pushIssueUpdate = (event) => broadcasts.push(event);
  proposalUpdate.withProposalLock = async (pool, sessionId, fn) => {
    locks.push({ pool, sessionId });
    return fn();
  };
  proposalUpdate.updateLinkedIssues = async (args) => {
    updates.push(args);
    return {
      changed: true,
      linkedIssues: [18, 27],
      addedIssues: [27],
      removedIssues: [12],
      prBodyUpdated: true,
      prBodyStatus: 'updated',
    };
  };
});

after(() => {
  proposalUpdate.updateLinkedIssues = originals.updateLinkedIssues;
  proposalUpdate.withProposalLock = originals.withProposalLock;
  github.parseGithubUrl = originals.parseGithubUrl;
  ws.pushIssueUpdate = originals.pushIssueUpdate;
});

test('the owner can replace associations with deltas and the board is refreshed', async () => {
  const server = await startServer();
  try {
    const result = await patch(server, { addIssues: [27, 27], removeIssues: [12] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      ok: true,
      proposalId: PROPOSAL_ID,
      appSlug: 'recipe-box',
      linkedIssues: [18, 27],
      addedIssues: [27],
      removedIssues: [12],
      changed: true,
      prBodyUpdated: true,
      prBodyStatus: 'updated',
    });
    assert.equal(updates.length, 1);
    assert.equal(locks.length, 1);
    assert.equal(locks[0].sessionId, PROPOSAL_ID,
      'the row read and PR-body projection share the proposal update lock');
    assert.deepEqual(updates[0].addIssues, [27]);
    assert.deepEqual(updates[0].removeIssues, [12]);
    assert.equal(updates[0].owner, 'acme');
    assert.deepEqual(broadcasts, [{
      action: 'updated', source: 'linked_issues', sessionId: PROPOSAL_ID,
      appId: 3, appSlug: 'recipe-box',
    }]);
  } finally { server.close(); }
});

test('a browser write admin may repair another proposal, but a connector admin may not', async () => {
  let server = await startServer(ADMIN);
  try {
    assert.equal((await patch(server, { addIssues: [27] })).status, 200);
  } finally { server.close(); }

  updates.length = 0;
  server = await startServer(ADMIN, { connector: true });
  try {
    assert.equal((await patch(server, { addIssues: [27] })).status, 404);
    assert.equal(updates.length, 0, 'the connector cannot borrow an admin repair privilege');
  } finally { server.close(); }
});

test('another collaborator gets an existence-hiding 404', async () => {
  const server = await startServer({ id: 8, username: 'other' });
  try {
    assert.equal((await patch(server, { removeIssues: [12] })).status, 404);
    assert.equal(updates.length, 0);
  } finally { server.close(); }
});

test('validation is strict, bounded, and refuses an over-limit final set', async () => {
  const server = await startServer();
  try {
    const invalid = [
      {},
      { addIssues: ['27'] },
      { addIssues: [0] },
      { addIssues: [2147483648] },
      { addIssues: [27], replacement: true },
      { addIssues: Array.from({ length: 51 }, (_, i) => i + 1) },
    ];
    for (const body of invalid) {
      assert.equal((await patch(server, body)).status, 400, JSON.stringify(body));
    }
    session = row({ linked_issues: Array.from({ length: 50 }, (_, i) => i + 1) });
    const over = await patch(server, { addIssues: [51] });
    assert.equal(over.status, 400);
    assert.match(over.body.message, /at most 50/i);
    assert.equal(updates.length, 0);
  } finally { server.close(); }
});
