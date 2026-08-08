// Staging mock data for the local coding agent (#907).
//
// Both new tables are `staging:private`, so a staging clone gets their shape
// and none of their rows: without an injection the Settings block and the
// dev-chat chip review as empty states. The rules the platform's mock-data
// convention imposes are the ones asserted here — request-time only, never a
// write, obviously fake, marked `demo: true`, and a hard no-op anywhere that
// is not exactly staging.
//
// Run with: node --test tests/local-agent-demo.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const demo = require('../src/services/local-agent-demo');

function withEnv(value, fn) {
  const previous = process.env.USERNODE_ENV;
  if (value === undefined) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = value;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previous;
  }
}

test('the injection is inert outside staging, whatever the query says', () => {
  for (const env of [undefined, 'production', 'local', 'Staging', 'staging-2']) {
    withEnv(env, () => {
      assert.equal(demo.isStagingDemo({ query: { demo: '1' } }), false, String(env));
    });
  }
});

test('in staging it needs the explicit opt-in, exactly', () => {
  withEnv('staging', () => {
    assert.equal(demo.isStagingDemo({ query: { demo: '1' } }), true);
    assert.equal(demo.isStagingDemo({ query: { demo: 'true' } }), false);
    assert.equal(demo.isStagingDemo({ query: { demo: 1 } }), false);
    assert.equal(demo.isStagingDemo({ query: {} }), false);
    assert.equal(demo.isStagingDemo({}), false);
    assert.equal(demo.isStagingDemo(null), false);
    assert.equal(demo.isStagingDemo(undefined), false);
  });
});

test('every demo row is obviously fake and flagged for the client', () => {
  const agents = demo.demoLocalAgents();
  assert.ok(agents.length >= 2, 'one row reads as a hardcoded string, not a list');
  for (const agent of agents) {
    assert.equal(agent.demo, true);
    assert.match(agent.label, /demo/i);
    assert.match(String(agent.leaseId), /^staging-demo-/);
    assert.match(agent.appSlug, /^staging-demo/);
    assert.match(agent.branch, /staging-demo/);
    assert.equal(agent.runtime, 'claude-code');
  }
  // Distinct labels and sessions: the reviewer has to be able to tell the
  // rows apart to see that this surface is a list.
  assert.equal(new Set(agents.map((a) => a.label)).size, agents.length);
  assert.equal(new Set(agents.map((a) => a.sessionTitle)).size, agents.length);
});

test('demo lease ids can never collide with a real one', () => {
  // Real lease ids are canonical positive bigints, which is exactly what the
  // DELETE route parses. A non-numeric id therefore cannot address a row even
  // if the client somehow posted one back.
  const { parseCanonicalPositiveBigint } = require('../src/services/cli-auth');
  for (const agent of demo.demoLocalAgents()) {
    assert.equal(parseCanonicalPositiveBigint(String(agent.leaseId)), null);
  }
});

test('demo timestamps are live-looking, not a frozen date from the past', () => {
  const [laptop] = demo.demoLocalAgents();
  const seen = Date.parse(laptop.lastSeenAt);
  const expires = Date.parse(laptop.expiresAt);
  assert.ok(Number.isFinite(seen) && Number.isFinite(expires));
  assert.ok(Math.abs(Date.now() - seen) < 5 * 60 * 1000, 'last seen reads as recent');
  assert.ok(expires > Date.now(), 'a demo machine must render as attached, not lapsed');
  assert.ok(Date.parse(laptop.createdAt) < seen);
});

test('the session runner demo lights the chip on whichever session is open', () => {
  const state = demo.demoSessionRunner(4242);
  assert.equal(state.runner, 'local');
  assert.equal(state.localAgent.sessionId, 4242);
  assert.equal(state.localAgent.demo, true);
  // A junk id must not produce NaN in a payload the browser reads.
  assert.equal(demo.demoSessionRunner('nope').localAgent.sessionId, 0);
  assert.equal(demo.demoSessionRunner(undefined).localAgent.sessionId, 0);
});

test('the module writes nothing — it has no pool, no query, no INSERT', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'local-agent-demo.js'), 'utf8'
  );
  for (const forbidden of ['INSERT', 'UPDATE ', 'DELETE', 'pool', 'query(']) {
    assert.equal(source.includes(forbidden), false,
      `staging mock data must never ${forbidden}`);
  }
});

test('the clients suppress destructive controls on a demo row', () => {
  const settings = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'settings.js'), 'utf8'
  );
  assert.match(settings, /!agent\.demo/, 'Settings hides Detach on a demo row');
  const devChat = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'), 'utf8'
  );
  assert.match(devChat, /agent\.demo/, 'dev chat refuses to release a demo lease');
});
