// Turn state machine for the local coding agent (#907).
//
// The platform and the machine each own half of a turn's lifecycle, and the
// split is the whole safety story:
//
//   platform owns  queued → offered, and the terminal states 'abandoned'
//                  (nobody picked it up / the machine went away) and
//                  'stopped' (the user pressed stop);
//   machine owns   accepted, running, and the terminal states 'completed'
//                  and 'failed'.
//
// Every transition below is a conditional UPDATE guarded on both the lease
// and the current status, so a machine that lost its lease, or that reports
// a result for a turn the platform already gave up on, changes nothing.
//
// Run with: node --test tests/local-agent-protocol.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const localAgent = require('../src/services/local-agent');

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
    last() { return this.calls[this.calls.length - 1]; },
  };
}

const TURN = {
  id: '11',
  session_id: 42,
  lease_id: '7',
  user_id: 5,
  status: 'running',
  prompt: 'add a button',
  base_sha: 'a'.repeat(40),
  branch_name: 'dev/x',
  head_sha: null,
  summary: null,
  error_detail: null,
  progress: [],
  created_at: '2026-08-06T10:00:00.000Z',
  updated_at: '2026-08-06T10:00:05.000Z',
  finished_at: null,
};

test('the read-only invariant is in the schema, not only in the code', () => {
  // Application guards can be gone around; a CHECK constraint cannot. A scout
  // row with a head SHA would reach the staging/checks tail and put unreviewed
  // code on the managed branch, so the database refuses it too.
  const fs = require('node:fs');
  const path = require('node:path');
  const schema = fs.readFileSync(
    path.join(__dirname, '../src/db/schema.sql'), 'utf8'
  );
  const block = schema.slice(
    schema.indexOf('CREATE TABLE IF NOT EXISTS local_agent_turns'),
    schema.indexOf("COMMENT ON TABLE local_agent_turns")
  );
  assert.match(block, /mode VARCHAR\(16\) NOT NULL DEFAULT 'build'/);
  assert.match(block, /CHECK \(mode IN \('build', 'scout'\)\)/);
  assert.match(block, /CHECK \(mode = 'build' OR head_sha IS NULL\)/);
  assert.match(block, /CHECK \(mode = 'scout' OR spec_md IS NULL\)/);
  // …and reachable on a database that already had the table, since
  // CREATE TABLE IF NOT EXISTS skips the definition above entirely.
  assert.match(block, /ADD COLUMN IF NOT EXISTS mode VARCHAR\(16\)/);
  assert.match(block, /ADD COLUMN IF NOT EXISTS spec_md TEXT/);
  assert.match(block, /local_agent_turns_readonly_check/);
  // The bound the service clips to and the column's own bound must agree, or
  // one of them is decorative.
  assert.match(block, new RegExp(`char_length\\(spec_md\\) <= ${localAgent.MAX_SPEC_CHARS}`));
});

test('the two status sets are disjoint and cover the schema', () => {
  const live = localAgent.LIVE_TURN_STATUSES;
  const done = localAgent.TERMINAL_TURN_STATUSES;
  assert.deepEqual([...live], ['queued', 'offered', 'accepted', 'running']);
  assert.deepEqual([...done],
    ['declined', 'completed', 'failed', 'stopped', 'abandoned']);
  assert.equal(live.some((s) => done.includes(s)), false);
});

test('enqueueTurn refuses to dispatch to a lease that is not the caller\'s', async () => {
  const pool = makePool([
    [/FROM session_agent_leases/, [{ id: '7', session_id: 42, user_id: 99 }]],
  ]);
  assert.equal(await localAgent.enqueueTurn(pool, {
    sessionId: 42, userId: 5, prompt: 'x',
  }), null);
  assert.equal(pool.calls.length, 1); // never reached the INSERT

  // No lease at all: null, so the Mayor falls back to a platform worker.
  const none = makePool([[/FROM session_agent_leases/, []]]);
  assert.equal(await localAgent.enqueueTurn(none, {
    sessionId: 42, userId: 5, prompt: 'x',
  }), null);
  assert.equal(none.calls.length, 1);
});

test('enqueueTurn carries the base commit and branch to the machine', async () => {
  const pool = makePool([
    [/FROM session_agent_leases/, [{ id: '7', session_id: 42, user_id: 5 }]],
    [/INSERT INTO local_agent_turns/, [{ ...TURN, status: 'queued' }]],
  ]);
  const result = await localAgent.enqueueTurn(pool, {
    sessionId: 42, userId: 5, prompt: 'add a button',
    baseSha: 'b'.repeat(40), branchName: 'dev/x',
  });
  assert.equal(result.turn.id, '11');
  assert.equal(result.lease.id, '7');
  const insert = pool.last();
  assert.deepEqual(
    insert.params,
    [42, '7', 5, 'add a button', 'b'.repeat(40), 'dev/x', 'build'],
    'and defaults to a build turn when the caller does not say'
  );
});

test('enqueueTurn dispatches scout turns down the same path, and rejects nonsense modes', async () => {
  const pool = makePool([
    [/FROM session_agent_leases/, [{ id: '7', session_id: 42, user_id: 5 }]],
    [/INSERT INTO local_agent_turns/, [{ ...TURN, mode: 'scout', status: 'queued' }]],
  ]);
  const result = await localAgent.enqueueTurn(pool, {
    sessionId: 42, userId: 5, prompt: 'draft a spec',
    baseSha: 'b'.repeat(40), branchName: 'dev/x', mode: 'scout',
  });
  assert.equal(result.turn.mode, 'scout');
  assert.equal(pool.last().params[6], 'scout');
  // A scout turn still carries a base SHA. It never commits, but reading the
  // WRONG revision produces a spec about code that is not there.
  assert.equal(pool.last().params[4], 'b'.repeat(40));

  // Rejected at the service boundary, not left to the column's CHECK: an
  // unknown mode reaching the machine is a turn the CLI cannot run at all.
  await assert.rejects(() => localAgent.enqueueTurn(pool, {
    sessionId: 42, userId: 5, prompt: 'x', mode: 'sudo',
  }), /Unsupported turn mode/);
  assert.deepEqual(localAgent.TURN_MODES, ['build', 'scout']);
  assert.equal(localAgent.isValidMode('scout'), true);
  assert.equal(localAgent.isValidMode('Scout'), false);
});

test('claimNextTurn takes the oldest queued turn for this lease only', async () => {
  const pool = makePool([[/UPDATE local_agent_turns/, [{ ...TURN, status: 'offered' }]]]);
  const turn = await localAgent.claimNextTurn(pool, {
    lease: { id: '7', session_id: 42 }, timeoutMs: 50,
  });
  assert.equal(turn.status, 'offered');
  const sql = pool.calls[0].sql;
  assert.match(sql, /status = 'offered'/);
  assert.match(sql, /WHERE lease_id = \$1 AND status = 'queued'/);
  assert.match(sql, /ORDER BY id ASC LIMIT 1/);
});

test('claimNextTurn returns null rather than hanging past its deadline', async () => {
  const pool = makePool([[/UPDATE local_agent_turns/, []]]);
  const started = Date.now();
  const turn = await localAgent.claimNextTurn(pool, {
    lease: { id: '7', session_id: 42 }, timeoutMs: 60,
  });
  assert.equal(turn, null);
  assert.ok(Date.now() - started >= 50);
});

test('accept and decline only apply to a turn actually offered to that lease', async () => {
  const accept = makePool([[/UPDATE local_agent_turns/, [{ ...TURN, status: 'accepted' }]]]);
  await localAgent.acceptTurn(accept, { turnId: '11', leaseId: '7' });
  assert.match(accept.last().sql, /WHERE id = \$1 AND lease_id = \$2 AND status = 'offered'/);

  const decline = makePool([[/UPDATE local_agent_turns/, [{ ...TURN, status: 'declined' }]]]);
  await localAgent.declineTurn(decline, {
    turnId: '11', leaseId: '7', reason: 'checkout is dirty',
  });
  assert.match(decline.last().sql, /status IN \('offered', 'accepted'\)/);
  assert.equal(decline.last().params[2], 'checkout is dirty');

  // A decline with no reason still says something the user can read.
  const bare = makePool([[/UPDATE local_agent_turns/, [TURN]]]);
  await localAgent.declineTurn(bare, { turnId: '11', leaseId: '7' });
  assert.match(bare.last().params[2], /declined/i);
});

test('the first progress post promotes accepted → running', async () => {
  const pool = makePool([[/UPDATE local_agent_turns/, [TURN]]]);
  await localAgent.appendProgress(pool, {
    turnId: '11', leaseId: '7', lines: ['Reading src/app.js'],
  });
  const sql = pool.last().sql;
  assert.match(sql, /WHEN status = 'accepted' THEN 'running'/);
  // The guard is what makes progress the cooperative stop signal: once the
  // platform flips the turn to 'stopped', this matches nothing and the route
  // answers 409, which is how the CLI learns to kill its child.
  assert.match(sql, /status IN \('accepted', 'running'\)/);
});

test('progress lines are bounded in count, length and character set', () => {
  const many = Array.from({ length: localAgent.MAX_PROGRESS_LINES + 25 }, (_, i) => `l${i}`);
  assert.equal(localAgent.normalizeProgress(many).length, localAgent.MAX_PROGRESS_LINES);

  const long = localAgent.normalizeProgress(['x'.repeat(10000)])[0];
  assert.ok(long.length < 10000);

  // A control character in a progress line would let a runtime forge extra
  // lines in the chat's progress card. Replaced, not dropped.
  const dirty = localAgent.normalizeProgress(['a\nb\u0000c']);
  assert.equal(dirty[0], 'a b c');

  assert.deepEqual(localAgent.normalizeProgress(['ok', '', 42, null, {}]), ['ok']);
  assert.deepEqual(localAgent.normalizeProgress('not an array'), []);
  assert.deepEqual(localAgent.normalizeProgress(undefined), []);
});

test('recordTurnHead insists on a real commit SHA', async () => {
  const pool = makePool([[/UPDATE local_agent_turns/, [TURN]]]);
  await assert.rejects(() => localAgent.recordTurnHead(pool, {
    turnId: '11', leaseId: '7', headSha: 'not-a-sha',
  }), /commit SHA/);
  await localAgent.recordTurnHead(pool, {
    turnId: '11', leaseId: '7', headSha: 'A'.repeat(40),
  });
  assert.equal(pool.last().params[2], 'a'.repeat(40)); // normalized to lower
  assert.equal(localAgent.isSha('a'.repeat(40)), true);
  assert.equal(localAgent.isSha('a'.repeat(39)), false);
  assert.equal(localAgent.isSha('g'.repeat(40)), false);
  // The read-only second lock: even given a perfectly valid SHA, the UPDATE
  // can only match a build turn. The route refuses a scout commit first, but
  // this is what makes "a scout turn can never have a head" true of the
  // service rather than only of one endpoint.
  assert.match(pool.last().sql, /AND mode = 'build'/);
});

test('finishTurn writes a spec for a scout turn and a head for a build turn, never both', async () => {
  const pool = makePool([[/UPDATE local_agent_turns/, [TURN]]]);
  await localAgent.finishTurn(pool, {
    turnId: '11', leaseId: '7', status: 'completed',
    headSha: 'a'.repeat(40), specMd: '# a spec', summary: 'done',
  });
  const { sql, params } = pool.last();
  // Both values are bound, and SQL decides which one survives from the row's
  // own mode — so a caller that passes the wrong pair writes nothing odd
  // instead of tripping the column CHECK and surfacing as a 500.
  assert.match(sql, /head_sha = CASE WHEN mode = 'build' THEN \$4 ELSE NULL END/);
  assert.match(sql, /spec_md = CASE WHEN mode = 'scout' THEN \$8 ELSE NULL END/);
  assert.equal(params[3], 'a'.repeat(40));
  assert.equal(params[7], '# a spec');

  // A whitespace-only spec is no spec. Otherwise a runtime that printed a
  // blank line would "complete" a scout turn with an empty spec doc, wiping
  // whatever the session had before.
  await localAgent.finishTurn(pool, {
    turnId: '11', leaseId: '7', status: 'completed', specMd: '   \n  ',
  });
  assert.equal(pool.last().params[7], null);

  // And a spec longer than the column allows is clipped rather than rejected
  // here — the route already 400s an oversized one, so reaching this path at
  // all means something internal built it.
  await localAgent.finishTurn(pool, {
    turnId: '11', leaseId: '7', status: 'completed',
    specMd: 'x'.repeat(localAgent.MAX_SPEC_CHARS + 500),
  });
  assert.equal(pool.last().params[7].length, localAgent.MAX_SPEC_CHARS);
});

test('finishTurn refuses statuses the machine is not allowed to declare', async () => {
  const pool = makePool([[/UPDATE local_agent_turns/, [TURN]]]);
  for (const status of ['running', 'queued', 'nonsense']) {
    await assert.rejects(() => localAgent.finishTurn(pool, {
      turnId: '11', leaseId: '7', status,
    }), /Unsupported terminal status/);
  }
  // A 'completed' with no usable head is honest, not an error: a run that
  // changed nothing has no commit to point at.
  await localAgent.finishTurn(pool, {
    turnId: '11', leaseId: '7', status: 'completed', headSha: null, summary: 'no changes',
  });
  assert.equal(pool.last().params[3], null);
  assert.deepEqual(pool.last().params[6], localAgent.LIVE_TURN_STATUSES);
});

test('awaitTurnResult abandons an offer nobody picked up, long before the turn timeout', async () => {
  const pool = makePool([
    [/SELECT \* FROM local_agent_turns/, [{ ...TURN, status: 'offered' }]],
    [/UPDATE local_agent_turns/, [{ ...TURN, status: 'abandoned' }]],
  ]);
  const result = await localAgent.awaitTurnResult(pool, '11', { offerTimeoutMs: 1 });
  assert.equal(result.outcome, 'abandoned');
  const update = pool.calls.find((c) => /UPDATE local_agent_turns/.test(c.sql));
  assert.match(update.sql, /did not pick up the turn/);
  // The offer window is far shorter than the outer bound: a sleeping laptop
  // must not cost the user an hour before the platform takes over.
  assert.ok(localAgent.OFFER_TIMEOUT_MS < localAgent.TURN_TIMEOUT_MS / 10);
});

test('awaitTurnResult returns immediately on a terminal turn and reports a missing one', async () => {
  const done = makePool([
    [/SELECT \* FROM local_agent_turns/, [{ ...TURN, status: 'completed', head_sha: 'c'.repeat(40) }]],
  ]);
  const result = await localAgent.awaitTurnResult(done, '11');
  assert.equal(result.outcome, 'completed');
  assert.equal(result.turn.head_sha, 'c'.repeat(40));

  const gone = makePool([[/SELECT \* FROM local_agent_turns/, []]]);
  assert.equal((await localAgent.awaitTurnResult(gone, '11')).outcome, 'missing');
});

test('requestStop only touches live turns, and says who stopped it', async () => {
  const pool = makePool([[/UPDATE local_agent_turns/, [{ ...TURN, status: 'stopped' }]]]);
  const turn = await localAgent.requestStop(pool, { sessionId: 42, userId: 5 });
  assert.equal(turn.status, 'stopped');
  assert.match(pool.last().sql, /status = 'stopped'/);
  assert.match(pool.last().sql, /Stopped from the Usernode dev chat/);
  assert.deepEqual(pool.last().params[2], localAgent.LIVE_TURN_STATUSES);

  // The orphan-stop path has no user in hand; the SQL must tolerate null
  // rather than silently matching nothing.
  await localAgent.requestStop(pool, { sessionId: 42, userId: null });
  assert.match(pool.last().sql, /\$2::INTEGER IS NULL OR user_id = \$2/);
});

test('recordTurnRunner clears the stale label when a turn comes back to the platform', async () => {
  const pool = makePool([[/UPDATE chat_sessions/, []]]);
  await localAgent.recordTurnRunner(pool, 42, 'local', 'work laptop');
  assert.deepEqual(pool.last().params, [42, 'local', 'work laptop']);
  await localAgent.recordTurnRunner(pool, 42, 'platform', 'work laptop');
  assert.deepEqual(pool.last().params, [42, 'platform', null]);
});

test('recordTurnRunner never breaks the turn it is only annotating', async () => {
  const pool = { async query() { throw new Error('db down'); } };
  await localAgent.recordTurnRunner(pool, 42, 'local', 'laptop'); // must not throw
});

test('publicTurn is the wire shape and carries no lease or user id', () => {
  const view = localAgent.publicTurn(TURN);
  assert.deepEqual(Object.keys(view).sort(), [
    'baseSha', 'branch', 'createdAt', 'error', 'finishedAt', 'headSha',
    'mode', 'prompt', 'sessionId', 'status', 'summary', 'turnId',
  ]);
  // Deliberately absent: spec_md. The machine WROTE the spec, so sending it
  // back would be pointless, and the column can hold 256 KiB.
  assert.equal('specMd' in view, false);
  assert.equal('lease_id' in view, false);
  assert.equal('user_id' in view, false);
  assert.equal('progress' in view, false);
  assert.equal(view.turnId, '11');
  assert.equal(localAgent.publicTurn(null), null);
});
