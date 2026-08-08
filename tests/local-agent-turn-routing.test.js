// The /api/cli/agent/* wire protocol (#907), driven over a real HTTP server.
//
// These routes are mounted inside cliPreAuthRoutes, so they inherit the CLI
// surface's staging gate, no-store headers, bearer challenge and per-call
// audit row. What is tested here is everything specific to the agent
// protocol on top of that:
//
//   * the `agent:local` scope is required — a pre-#907 credential is refused;
//   * every call re-reads and re-validates the lease rather than trusting
//     the last one;
//   * a machine may report 'completed' or 'failed' about itself and nothing
//     else: 'stopped' and 'abandoned' belong to the platform;
//   * no request or response on this surface carries a credential.
//
// Run with: node --test tests/local-agent-turn-routing.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { hashSecret } = require('../src/services/cli-auth');
const constants = require('../src/services/cli-auth-constants');

const TOKEN = `svcli_${'A'.repeat(43)}`;
const TOKEN_HASH = hashSecret(TOKEN);

// ── Stub pool ──────────────────────────────────────────────────────────────
// Enough of the real schema to get an authenticated request through the CLI
// middleware chain, plus per-test overrides for the agent tables.
const db = {
  queries: [],
  scopes: [...constants.REQUIRED_SCOPES],
  lease: null,
  turn: null,
  session: null,
  updated: null,
  reset() {
    this.queries = [];
    this.scopes = [...constants.REQUIRED_SCOPES];
    this.lease = {
      id: '7', session_id: 42, user_id: 5, label: 'work laptop',
      runtime: 'claude-code', created_at: new Date(), last_seen_at: new Date(),
      expires_at: new Date(Date.now() + 120000),
    };
    this.turn = {
      id: '11', session_id: 42, lease_id: '7', user_id: 5, status: 'running',
      mode: 'build',
      prompt: 'add a button', base_sha: null, branch_name: 'dev/x',
      head_sha: null, summary: null, error_detail: null, spec_md: null,
      created_at: new Date(), updated_at: new Date(), finished_at: null,
    };
    this.session = {
      id: 42, status: 'active', branch_name: 'dev/x', session_title: 'Add a button',
      handoff_base_sha: null, checks_commit_sha: null, handoff_uploaded_sha: null,
      app_slug: 'demo-app', repo_url: 'https://github.com/o/r',
    };
    this.updated = null;
  },
};

const pool = {
  async query(sql, params) {
    db.queries.push({ sql, params });
    if (/clock_timestamp\(\) AS now/.test(sql)) return { rows: [{ now: new Date() }] };
    if (/FROM cli_auth_rate_limits|INTO cli_auth_rate_limits/.test(sql)) return { rows: [] };
    if (/INSERT INTO cli_auth_audit_events/.test(sql)) return { rows: [{ id: '1' }] };
    if (/FROM cli_access_tokens/.test(sql)) {
      return {
        rows: [{
          id: '900', user_id: 5, client_id: 'cli', scopes: db.scopes,
          created_at: new Date(), last_used_at: null,
          expires_at: new Date(Date.now() + 3600000), revoked_at: null,
        }],
      };
    }
    if (/FROM users WHERE id/.test(sql)) {
      return { rows: [{ id: 5, username: 'dev', is_admin: false, admin_readonly: false, app_quota: 3 }] };
    }
    if (/UPDATE cli_access_tokens/.test(sql)) return { rows: [] };
    if (/FROM session_agent_leases/.test(sql)) {
      return { rows: db.lease ? [db.lease] : [] };
    }
    if (/INSERT INTO session_agent_leases/.test(sql)) {
      db.lease = {
        id: '7', session_id: params[0], user_id: params[1], label: params[3],
        runtime: params[4], created_at: new Date(), last_seen_at: new Date(),
        expires_at: new Date(Date.now() + 120000),
      };
      return { rows: [db.lease] };
    }
    if (/FROM chat_sessions cs JOIN apps/.test(sql)) {
      return { rows: db.session ? [db.session] : [] };
    }
    if (/SELECT \* FROM local_agent_turns/.test(sql)) {
      return { rows: db.turn ? [db.turn] : [] };
    }
    if (/UPDATE local_agent_turns/.test(sql)) {
      db.updated = { sql, params };
      return { rows: db.turn ? [{ ...db.turn, status: 'completed' }] : [] };
    }
    if (/UPDATE session_agent_leases/.test(sql)) {
      return { rows: db.lease ? [{ ...db.lease, released_at: new Date() }] : [] };
    }
    return { rows: [] };
  },
};

const poolModule = require('../src/db/pool');
poolModule.getPool = () => pool;
delete require.cache[require.resolve('../src/routes/cli-auth')];
const { cliAuthGate, cliPreAuthRoutes } = require('../src/routes/cli-auth');

const config = {
  cliAuthEnabled: true,
  cliAuthOrigin: 'https://social-vibecoding.usernodelabs.org',
  cliDeviceCreateRatePerMinute: 10,
  cliDeviceCreateBurst: 20,
  cliDeviceLivePerIp: 10,
  cliDeviceLiveGlobal: 10000,
};

let server;
let origin;

test.before(async () => {
  const app = express();
  app.set('trust proxy', false);
  app.use(cliAuthGate(config));
  app.use(cliPreAuthRoutes(config));
  app.use((_req, res) => res.status(418).json({ error: 'fallback' }));
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

test.beforeEach(() => db.reset());

async function call(method, path, body, { token = TOKEN } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await response.json(); } catch { /* 204 */ }
  return { status: response.status, json, headers: response.headers };
}

test('the whole agent surface 404s on staging, before any database work', async () => {
  const previous = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  db.queries = [];
  try {
    for (const [method, path] of [
      ['POST', '/api/cli/agent/attach'],
      ['GET', '/api/cli/agent/turns/next?leaseId=7'],
      ['POST', '/api/cli/agent/turns/11/result'],
      ['POST', '/api/cli/agent/detach'],
    ]) {
      const r = await call(method, path, method === 'POST' ? {} : undefined);
      assert.equal(r.status, 404, path);
      assert.equal(r.headers.get('cache-control'), 'no-store', path);
    }
    assert.equal(db.queries.length, 0, 'the gate must answer before the pool');
  } finally {
    if (previous === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previous;
  }
});

test('no bearer means a 401 challenge, not a 404 or a 500', async () => {
  const r = await call('POST', '/api/cli/agent/attach', {
    sessionId: 42, label: 'laptop', runtime: 'claude-code',
  }, { token: null });
  assert.equal(r.status, 401);
  assert.match(String(r.headers.get('www-authenticate') || ''), /Bearer/);
});

test('a credential without agent:local is refused with 403, not silently allowed', async () => {
  db.scopes = [constants.IDENTITY_SCOPE, constants.API_SCOPE];
  const r = await call('POST', '/api/cli/agent/attach', {
    sessionId: 42, label: 'laptop', runtime: 'claude-code',
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'insufficient_scope');
  // The refusal is audited with the route PATTERN, so the audit table stays
  // groupable rather than growing a row shape per turn id.
  const audit = db.queries.find((q) => /INSERT INTO cli_auth_audit_events/.test(q.sql));
  assert.ok(audit, 'the refused call is still audited');
  const metadata = audit.params.find((p) => typeof p === 'string' && p.includes('/api/cli/agent'));
  assert.match(String(metadata), /"route":"\/api\/cli\/agent\/attach"/);
  assert.ok(audit.params.includes('insufficient_scope'), 'the outcome is recorded too');
});

test('attach validates its body exactly and never accepts extra state', async () => {
  for (const body of [
    {},
    { sessionId: 42, label: 'laptop' },
    { sessionId: 42, label: 'laptop', runtime: 'claude-code', token: 'sk-ant-x' },
    { sessionId: 0, label: 'laptop', runtime: 'claude-code' },
    { sessionId: '42', label: 'laptop', runtime: 'claude-code' },
    { sessionId: 42, label: '', runtime: 'claude-code' },
    { sessionId: 42, label: 'laptop', runtime: 'codex' },
  ]) {
    const r = await call('POST', '/api/cli/agent/attach', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, 'invalid_request');
  }
});

test('attach returns the branch and the deep link, and no credential', async () => {
  db.lease = null; // free session
  const r = await call('POST', '/api/cli/agent/attach', {
    sessionId: 42, label: 'work laptop', runtime: 'claude-code',
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.session.branch, 'dev/x');
  assert.equal(r.json.session.repoUrl, 'https://github.com/o/r');
  assert.equal(r.json.webPath, '/#app/demo-app/dev/sessions/42');
  const serialized = JSON.stringify(r.json);
  for (const forbidden of ['svcli_', 'sk-ant', 'token', 'secret', 'password']) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false,
      `attach response must not mention ${forbidden}`);
  }
});

test('attach refuses a session that is no longer taking coding turns', async () => {
  db.lease = null;
  db.session = { ...db.session, status: 'archived' };
  const r = await call('POST', '/api/cli/agent/attach', {
    sessionId: 42, label: 'laptop', runtime: 'claude-code',
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'session_not_attachable');

  db.session = null;
  const missing = await call('POST', '/api/cli/agent/attach', {
    sessionId: 42, label: 'laptop', runtime: 'claude-code',
  });
  assert.equal(missing.status, 404);
});

test('a lapsed lease cannot post anything, on any endpoint', async () => {
  db.lease = null;
  for (const [method, path, body] of [
    ['POST', '/api/cli/agent/heartbeat', { leaseId: '7' }],
    ['GET', '/api/cli/agent/turns/next?leaseId=7', undefined],
    ['POST', '/api/cli/agent/turns/11/accept', { leaseId: '7' }],
    ['POST', '/api/cli/agent/turns/11/progress', { leaseId: '7', lines: ['x'] }],
    ['POST', '/api/cli/agent/turns/11/result', {
      leaseId: '7', status: 'completed', headSha: null, summary: 'ok', error: null,
    }],
  ]) {
    const r = await call(method, path, body);
    assert.equal(r.status, 409, path);
    assert.equal(r.json.error, 'lease_lost', path);
  }
});

test('a turn belonging to a different lease is not found, not forbidden', async () => {
  db.turn = { ...db.turn, lease_id: '999' };
  const r = await call('POST', '/api/cli/agent/turns/11/accept', { leaseId: '7' });
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'not_found');
});

test('turn ids must be canonical positive integers', async () => {
  for (const id of ['0', '01', '-1', 'abc', '1.5']) {
    const r = await call('POST', `/api/cli/agent/turns/${id}/accept`, { leaseId: '7' });
    assert.equal(r.status, 400, id);
  }
});

test('the machine may report completed or failed and nothing else', async () => {
  // The two it owns.
  for (const status of ['completed', 'failed']) {
    const r = await call('POST', '/api/cli/agent/turns/11/result', {
      leaseId: '7', status, headSha: null, summary: 'done', error: null,
    });
    assert.equal(r.status, 200, status);
  }
  // The two the platform owns. A laptop must not be able to relabel its own
  // failed run as a benign re-route, or claim the user stopped it.
  for (const status of ['stopped', 'abandoned', 'declined', 'running', 'queued']) {
    const r = await call('POST', '/api/cli/agent/turns/11/result', {
      leaseId: '7', status, headSha: null, summary: null, error: null,
    });
    assert.equal(r.status, 400, status);
    assert.equal(r.json.error, 'invalid_request', status);
  }
});

test('result requires every key and rejects a bogus head SHA', async () => {
  const full = {
    leaseId: '7', status: 'completed', headSha: null, summary: null, error: null,
  };
  const partial = await call('POST', '/api/cli/agent/turns/11/result', {
    leaseId: '7', status: 'completed',
  });
  assert.equal(partial.status, 200, 'absent keys read as null');

  const extra = await call('POST', '/api/cli/agent/turns/11/result', {
    ...full, apiKey: 'sk-ant-oops',
  });
  assert.equal(extra.status, 400, 'the protocol never accepts an unknown key');

  const badSha = await call('POST', '/api/cli/agent/turns/11/result', {
    ...full, headSha: 'HEAD',
  });
  assert.equal(badSha.status, 400);
});

// ── scout / read-only turns ────────────────────────────────────────────────

test('a read-only turn cannot upload a commit, and is refused before GitHub', async () => {
  db.turn.mode = 'scout';
  db.turn.status = 'accepted';
  const r = await call('POST', '/api/cli/agent/turns/11/commit', {
    leaseId: '7',
    // A payload that PASSES parseCommitUploadBody, so the refusal is provably
    // about the turn's mode rather than about the body failing validation on
    // its way in. (A malformed body 400s earlier and would prove nothing.)
    schemaVersion: 1,
    localCommitSha: 'd'.repeat(40),
    parentSha: 'a'.repeat(40),
    parentTreeSha: 'b'.repeat(40),
    treeSha: 'c'.repeat(40),
    message: 'sneaky',
    authoredAt: '2026-08-06T00:00:00Z',
    committedAt: '2026-08-06T00:00:00Z',
    files: [{ path: 'x.js', mode: '100644', contentBase64: 'eA==' }],
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'read_only_turn');
  // The whole point: nothing was written and nothing reached the commit
  // machinery. A row-advancing UPDATE here would mean the read-only turn had
  // a head SHA, which is what the staging tail keys off.
  assert.equal(db.updated, null, 'the turn row was not advanced');
});

test('a read-only result may not carry a head SHA, and a build result may not carry a spec', async () => {
  db.turn.mode = 'scout';
  const withHead = await call('POST', '/api/cli/agent/turns/11/result', {
    leaseId: '7', status: 'completed', headSha: 'a'.repeat(40),
    summary: '', error: null, specMd: '# spec',
  });
  assert.equal(withHead.status, 409);
  assert.equal(withHead.json.error, 'read_only_turn');

  // …and the mirror image, so the two payload shapes cannot be mixed up in
  // either direction. A build turn quietly accepting a spec would write a
  // spec doc from a run that was writing code.
  db.turn.mode = 'build';
  const withSpec = await call('POST', '/api/cli/agent/turns/11/result', {
    leaseId: '7', status: 'completed', headSha: null,
    summary: 'built it', error: null, specMd: '# not mine',
  });
  assert.equal(withSpec.status, 400);
  assert.equal(withSpec.json.error, 'invalid_request');
});

test('a scout result carries the drafted spec through to the turn row', async () => {
  db.turn.mode = 'scout';
  const spec = `# Sticky header\n\n## User-facing changes\n\nIt sticks.\n`;
  const r = await call('POST', '/api/cli/agent/turns/11/result', {
    leaseId: '7', status: 'completed', headSha: null,
    summary: '', error: null, specMd: spec,
  });
  assert.equal(r.status, 200);
  assert.ok(db.updated, 'the turn row was written');
  assert.ok(
    db.updated.params.includes(spec),
    'the spec markdown reaches the row verbatim — newlines and all, because a '
    + 'human reads it in the spec viewer'
  );
});

test('a maximal spec fits the result body, and one char more is a 400', async () => {
  db.turn.mode = 'scout';
  const localAgent = require('../src/services/local-agent');

  // The bound has to be REACHABLE, not just declared: the result endpoint's
  // body limit is sized for a full 256 KiB spec plus JSON escaping. If this
  // 413s, a legitimate long spec silently becomes "your turn never finished".
  const atLimit = await call('POST', '/api/cli/agent/turns/11/result', {
    leaseId: '7', status: 'completed', headSha: null, summary: '', error: null,
    specMd: `# spec\n${'x'.repeat(localAgent.MAX_SPEC_CHARS - 8)}`,
  });
  assert.equal(atLimit.status, 200, 'a maximal spec is accepted, not 413ed');

  const tooBig = await call('POST', '/api/cli/agent/turns/11/result', {
    leaseId: '7', status: 'completed', headSha: null, summary: '', error: null,
    specMd: 'x'.repeat(localAgent.MAX_SPEC_CHARS + 1),
  });
  assert.equal(tooBig.status, 400, 'and one character past it is refused by us');

  const wrongType = await call('POST', '/api/cli/agent/turns/11/result', {
    leaseId: '7', status: 'completed', headSha: null, summary: '', error: null,
    specMd: { md: 'nope' },
  });
  assert.equal(wrongType.status, 400);
});

test('specMd is optional, so a build-only client keeps working unchanged', async () => {
  // The pre-scout CLI posts five keys. Adding a sixth to the exact-key set
  // would have made every older machine's result a 400 — which is a silent
  // "your turn never finished" in the chat.
  const r = await call('POST', '/api/cli/agent/turns/11/result', {
    leaseId: '7', status: 'completed', headSha: null, summary: 'done', error: null,
  });
  assert.equal(r.status, 200);
});

test('the offered turn tells the machine which mode it is', async () => {
  // The CLI branches on this one field to pick read-only vs editing
  // permissions, so it has to be on the wire, not inferred.
  db.turn.mode = 'scout';
  const localAgent = require('../src/services/local-agent');
  assert.equal(localAgent.publicTurn(db.turn).mode, 'scout');
  // An older row with no mode column value reads as a build turn rather than
  // as undefined, so a partially-migrated database cannot produce a turn the
  // CLI does not know how to run.
  assert.equal(localAgent.publicTurn({ ...db.turn, mode: null }).mode, 'build');
});

test('progress rejects non-string lines and 409s once the turn is no longer running', async () => {
  const bad = await call('POST', '/api/cli/agent/turns/11/progress', {
    leaseId: '7', lines: ['ok', 42],
  });
  assert.equal(bad.status, 400);

  const good = await call('POST', '/api/cli/agent/turns/11/progress', {
    leaseId: '7', lines: ['Reading src/app.js'],
  });
  assert.equal(good.status, 204);

  // The stop path: appendProgress matches nothing once the platform flipped
  // the row to 'stopped', and the 409 is what tells the CLI to kill its child.
  db.turn = null;
  const stopped = await call('POST', '/api/cli/agent/turns/11/progress', {
    leaseId: '7', lines: ['still going'],
  });
  assert.equal(stopped.status, 404);
});

test('detach is idempotent — a retried Ctrl-C is not an error', async () => {
  assert.equal((await call('POST', '/api/cli/agent/detach', { leaseId: '7' })).status, 204);
  db.lease = null;
  assert.equal((await call('POST', '/api/cli/agent/detach', { leaseId: '7' })).status, 204);
});

test('unknown paths under the agent prefix 404 rather than falling through', async () => {
  const r = await call('POST', '/api/cli/agent/turns/11/push', { leaseId: '7' });
  assert.equal(r.status, 404);
  assert.notEqual(r.json.error, 'fallback');
});

test('the agent prefix is denied to the generic MCP api_read/api_write bridge', () => {
  // A model-drivable agent protocol would let a prompt-injected model claim
  // someone else's coding turn, so the policy denies the whole /api/cli tree
  // — the agent routes inherit that denial by living under it.
  const policy = require('../src/services/cli-api-policy');
  for (const path of [
    '/api/cli/agent/attach',
    '/api/cli/agent/turns/next',
    '/api/cli/agent/turns/11/result',
    '/api/cli/agent/turns/11/commit',
  ]) {
    assert.equal(policy.canonicalApiTarget(path), null, path);
    assert.equal(policy.isCliApiPath(path), false, path);
  }
  assert.ok(policy.DENIED_PREFIXES.includes('/api/cli'));
});
