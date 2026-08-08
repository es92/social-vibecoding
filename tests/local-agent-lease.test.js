// Lease lifecycle for the local coding agent (#907).
//
// A lease is the single answer to "is one of this user's own machines
// attached to this session right now". Everything downstream — the Mayor's
// routing decision, the dev-chat chip, the Settings row, the stop button —
// reads it, so the rules it enforces are the ones tested here:
//
//   * one machine per session, and re-attaching the SAME machine refreshes
//     rather than conflicts (`agent run` is expected to be Ctrl-C'd);
//   * a lease that stops heartbeating stops counting as live, and the turn
//     it was running becomes 'abandoned' (re-routable), never 'failed';
//   * publicLease() never leaks the access token it was minted against.
//
// Run with: node --test tests/local-agent-lease.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const localAgent = require('../src/services/local-agent');

// Matches each query() against [regex, rows] handlers, first match wins.
function makePool(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of handlers) {
        if (re.test(sql)) {
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      return { rows: [] };
    },
    issued(re) { return this.calls.some((c) => re.test(c.sql)); },
  };
}

const LEASE = {
  id: '7',
  session_id: 42,
  user_id: 5,
  access_token_id: '900',
  label: 'work laptop',
  runtime: 'claude-code',
  created_at: '2026-08-06T10:00:00.000Z',
  last_seen_at: '2026-08-06T10:00:30.000Z',
  expires_at: '2026-08-06T10:02:30.000Z',
};

test('activeLease only counts unreleased, unexpired rows', async () => {
  const pool = makePool([[/FROM session_agent_leases/, [LEASE]]]);
  const lease = await localAgent.activeLease(pool, 42);
  assert.equal(lease.id, '7');
  const sql = pool.calls[0].sql;
  assert.match(sql, /released_at IS NULL/);
  assert.match(sql, /expires_at > NOW\(\)/);
});

test('attach refuses a second machine but refreshes the same one', async () => {
  // Different label on the same session — a genuine conflict.
  const held = makePool([[/SELECT \* FROM session_agent_leases/, [LEASE]]]);
  await assert.rejects(
    () => localAgent.attach(held, {
      sessionId: 42, userId: 5, label: 'desktop', runtime: 'claude-code',
    }),
    (err) => err instanceof localAgent.LeaseConflictError && err.code === 'lease_held'
  );
  assert.equal(held.issued(/INSERT INTO session_agent_leases/), false);

  // Same user, same label, same runtime — a restarted CLI, so refresh.
  const same = makePool([
    [/SELECT \* FROM session_agent_leases/, [LEASE]],
    [/UPDATE session_agent_leases/, [{ ...LEASE, last_seen_at: 'later' }]],
  ]);
  const result = await localAgent.attach(same, {
    sessionId: 42, userId: 5, label: 'work laptop', runtime: 'claude-code',
    accessTokenId: '901',
  });
  assert.equal(result.reattached, true);
  assert.equal(result.lease.last_seen_at, 'later');
  assert.equal(same.issued(/INSERT INTO session_agent_leases/), false);

  // Another user's machine on the same session is a conflict too, even with
  // an identical label — labels are user-chosen and collide freely.
  const other = makePool([[/SELECT \* FROM session_agent_leases/, [LEASE]]]);
  await assert.rejects(() => localAgent.attach(other, {
    sessionId: 42, userId: 6, label: 'work laptop', runtime: 'claude-code',
  }), /Another machine/);
});

test('a lost race on the unique index reports lease_held, not a 500', async () => {
  const pool = {
    n: 0,
    async query(sql) {
      if (/INSERT INTO session_agent_leases/.test(sql)) {
        const err = new Error('duplicate key');
        err.code = '23505';
        throw err;
      }
      this.n += 1;
      // First SELECT: free. Second (inside the catch): taken.
      return { rows: this.n === 1 ? [] : [LEASE] };
    },
  };
  await assert.rejects(
    () => localAgent.attach(pool, {
      sessionId: 42, userId: 5, label: 'laptop', runtime: 'claude-code',
    }),
    (err) => err.code === 'lease_held' && err.existing.id === '7'
  );
});

test('release marks a live turn abandoned, never failed', async () => {
  const pool = makePool([
    [/UPDATE session_agent_leases/, [{ ...LEASE, released_at: 'now' }]],
    [/UPDATE local_agent_turns/, [{ session_id: 42 }]],
  ]);
  const lease = await localAgent.release(pool, {
    leaseId: '7', userId: 5, reason: 'settings',
  });
  assert.ok(lease);
  const turnUpdate = pool.calls.find((c) => /UPDATE local_agent_turns/.test(c.sql));
  assert.match(turnUpdate.sql, /status = 'abandoned'/);
  assert.equal(turnUpdate.sql.includes("'failed'"), false);
  // Only live statuses transition — a turn that already completed is not
  // retroactively rewritten because the machine went away afterwards.
  assert.deepEqual(turnUpdate.params[2], localAgent.LIVE_TURN_STATUSES);
});

test('release is a no-op when the lease is already gone', async () => {
  const pool = makePool([[/UPDATE session_agent_leases/, []]]);
  assert.equal(await localAgent.release(pool, { leaseId: '7', userId: 5, reason: 'x' }), null);
  assert.equal(pool.issued(/UPDATE local_agent_turns/), false);
});

test('the sweeper reaps lapsed leases and abandons what they were running', async () => {
  const pool = makePool([
    [/UPDATE session_agent_leases/, [{ id: '7', session_id: 42 }, { id: '8', session_id: 43 }]],
    [/UPDATE local_agent_turns/, [{ session_id: 42 }]],
  ]);
  assert.equal(await localAgent.sweepExpiredLeases(pool), 2);
  const sweep = pool.calls[0];
  assert.match(sweep.sql, /release_reason = 'expired'/);
  assert.match(sweep.sql, /expires_at <= NOW\(\)/);
  assert.match(pool.calls[1].sql, /status = 'abandoned'/);

  // Nothing expired: no second query at all.
  const quiet = makePool([[/UPDATE session_agent_leases/, []]]);
  assert.equal(await localAgent.sweepExpiredLeases(quiet), 0);
  assert.equal(quiet.calls.length, 1);
});

test('heartbeat cannot revive an expired or another user\'s lease', async () => {
  const pool = makePool([[/UPDATE session_agent_leases/, [LEASE]]]);
  await localAgent.heartbeat(pool, { leaseId: '7', userId: 5 });
  const sql = pool.calls[0].sql;
  assert.match(sql, /user_id = \$2/);
  assert.match(sql, /released_at IS NULL/);
  assert.match(sql, /expires_at > NOW\(\)/);
});

test('the TTL is a comfortable multiple of the heartbeat', () => {
  // A single dropped heartbeat (flaky wifi, a laptop that slept for a
  // moment) must not detach the machine mid-run.
  assert.ok(localAgent.LEASE_TTL_MS >= localAgent.HEARTBEAT_MS * 3);
  assert.equal(localAgent.publicLease(LEASE).heartbeatSeconds,
    Math.round(localAgent.HEARTBEAT_MS / 1000));
});

test('publicLease exposes routing state and never the credential behind it', () => {
  const view = localAgent.publicLease(LEASE);
  assert.deepEqual(Object.keys(view).sort(), [
    'createdAt', 'expiresAt', 'heartbeatSeconds', 'label', 'lastSeenAt',
    'leaseId', 'runtime', 'sessionId',
  ]);
  assert.equal('access_token_id' in view, false);
  assert.equal('accessTokenId' in view, false);
  assert.equal(view.leaseId, '7');       // bigint as string, never a Number
  assert.equal(typeof view.sessionId, 'number');
  assert.equal(localAgent.publicLease(null), null);
});

test('labels are display text, so control characters are refused outright', () => {
  assert.equal(localAgent.isValidLabel('work laptop'), true);
  assert.equal(localAgent.isValidLabel('a'.repeat(localAgent.MAX_LABEL_CHARS)), true);
  assert.equal(localAgent.isValidLabel('a'.repeat(localAgent.MAX_LABEL_CHARS + 1)), false);
  assert.equal(localAgent.isValidLabel(''), false);
  assert.equal(localAgent.isValidLabel(' padded '), false);
  assert.equal(localAgent.isValidLabel('two\nlines'), false);
  assert.equal(localAgent.isValidLabel('bell\u0007'), false);
  assert.equal(localAgent.isValidLabel('del\u007f'), false);
  assert.equal(localAgent.isValidLabel(42), false);
  assert.equal(localAgent.isValidLabel(null), false);
});

test('only known runtimes attach', () => {
  assert.equal(localAgent.isValidRuntime('claude-code'), true);
  assert.equal(localAgent.isValidRuntime('codex'), false);
  assert.equal(localAgent.isValidRuntime(''), false);
  assert.equal(localAgent.isValidRuntime(undefined), false);
  assert.ok(localAgent.RUNTIMES.includes('claude-code'));
});

test('revoking a credential releases its leases and abandons their turns', async () => {
  const pool = makePool([
    [/UPDATE session_agent_leases/, [{ id: '7', session_id: 42 }, { id: '8', session_id: 43 }]],
    [/UPDATE local_agent_turns/, [{ session_id: 42 }]],
  ]);
  const result = await localAgent.releaseLeasesForTokens(pool, '900');
  assert.equal(result.released, 2);
  assert.deepEqual(result.sessionIds.sort(), [42, 43]);
  const [lease, turns] = pool.calls;
  assert.match(lease.sql, /release_reason = 'revoked'/);
  assert.match(lease.sql, /access_token_id = ANY/);
  assert.match(lease.sql, /released_at IS NULL/, 'never re-release a released lease');
  assert.match(turns.sql, /status = 'abandoned'/);
  // Abandoned, not failed: the user's request is fine, only the machine is
  // gone, so the next dispatch goes to a platform worker.
  assert.deepEqual(turns.params[1], localAgent.LIVE_TURN_STATUSES);
});

test('a revocation that touched nothing issues no follow-up write', async () => {
  const pool = makePool([[/UPDATE session_agent_leases/, []]]);
  assert.deepEqual(
    await localAgent.releaseLeasesForTokens(pool, '900'),
    { released: 0, sessionIds: [] }
  );
  assert.equal(pool.calls.length, 1);
  // And an empty id list does not even reach the database — every token
  // revocation calls this, including the overwhelming majority with no
  // machine attached.
  const idle = makePool([]);
  assert.deepEqual(
    await localAgent.releaseLeasesForTokens(idle, []),
    { released: 0, sessionIds: [] }
  );
  assert.equal(idle.calls.length, 0);
});

test('notifyReleased tolerates the shapes the callers actually pass it', () => {
  // The routes call it unconditionally after COMMIT, including on the path
  // where the token was already revoked and nothing ran.
  assert.doesNotThrow(() => localAgent.notifyReleased(null));
  assert.doesNotThrow(() => localAgent.notifyReleased(undefined));
  assert.doesNotThrow(() => localAgent.notifyReleased({ released: 0, sessionIds: [] }));
  assert.doesNotThrow(() => localAgent.notifyReleased({ released: 1, sessionIds: [42] }));
});
