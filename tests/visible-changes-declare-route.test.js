'use strict';

// The hosted build turn's declare_visible_changes reaches
// POST /api/internal/sessions/:id/visible-changes (src/routes/internal.js).
// Besides recording the declaration, it tells the building agent whose
// browser the shots agent will use when that cannot show the change, and
// what data the copies hold (shots-ready-states.js), while the agent can
// still declare again.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.WORKER_JWT_SECRET = process.env.WORKER_JWT_SECRET || 'declare-route-test-secret';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'declare-route-test-secret';

const queries = [];
let appRow = { id: 7, slug: 'vote-inbox' };
require('../src/db/pool').getPool = () => ({
  async query(sql, params) {
    queries.push({ sql, params });
    return { rows: appRow ? [appRow] : [] };
  },
});

const shotsState = require('../src/services/shots-state');
const shotsIdentities = require('../src/services/shots-identities');
const platformJwt = require('../src/services/platform-jwt');
const { internalRoutes, IMPACT_NONE_DIAGRAM_NUDGE } = require('../src/routes/internal');

async function serve(t) {
  const app = express();
  app.use(express.json());
  app.use(internalRoutes({ jwtSecret: process.env.JWT_SECRET, selfAppSlug: 'usernode-self', shots: { collect: true } }));
  const server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/internal/sessions/42/visible-changes`;
}

function stub(t, object, key, value) {
  const original = object[key];
  object[key] = value;
  t.after(() => { object[key] = original; });
}

const declare = async (url, intent) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${platformJwt.signWorkerToken({ sessionId: 42 })}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ intent }),
  });
  return { status: response.status, body: await response.json() };
};

test('in-flight old push tokens can only declare visuals for their own session', async t => {
  stub(t, shotsState, 'recordIntent', async (_pool, sessionId, intent) => ({
    accepted: true, unchanged: false, required: false, state: 'not_required', intent, sessionId,
  }));
  const url = await serve(t);
  const token = platformJwt.signWorkerPurpose({ sessionId: 42, purpose: 'worker:push' });
  const post = path => fetch(path, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ intent: { version: 1, impact: 'none', rationale: 'Server only.', stories: [] } }) });
  const out = await post(url);
  assert.equal(out.status, 200);
  assert.equal((await out.json()).ok, true);
  assert.equal((await post(url.replace('/42/', '/43/'))).status, 403);
  const issues = await fetch(url.replace('/visible-changes', '/issues'), { headers: { authorization: `Bearer ${token}` } });
  assert.equal(issues.status, 401, 'compatibility never widens request-read authority');
  for (const endpoint of ['push', 'pr']) {
    const retired = await post(url.replace('/visible-changes', `/${endpoint}`));
    assert.equal(retired.status, 410);
    assert.equal((await retired.json()).permanent, true);
  }
});

test('a recorded declaration carries the persona warnings for its app', async (t) => {
  const intent = { version: 1, impact: 'ui', stories: [{ id: 'summary-line', persona: 'guest', claim: 'A line.' }] };
  stub(t, shotsState, 'recordIntent', async (_pool, sessionId, raw) => ({
    accepted: true, unchanged: false, required: true, state: 'planned', intent: raw, runId: null, sessionId,
  }));
  const seen = [];
  stub(t, shotsIdentities, 'personaWarnings', async (_pool, app, declared, options) => {
    seen.push({ app, declared, options });
    return ['summary-line is declared for guest, but this app is private.'];
  });
  const url = await serve(t);

  const answered = await declare(url, intent);
  assert.equal(answered.status, 200);
  assert.equal(answered.body.ok, true);
  assert.equal(answered.body.shots.state, 'planned');
  assert.deepEqual(answered.body.warnings, ['summary-line is declared for guest, but this app is private.']);
  assert.deepEqual(seen[0].app, appRow, 'the proposal\'s own app');
  assert.deepEqual(seen[0].declared, intent);
  assert.deepEqual(seen[0].options, { selfApp: false });
  assert.deepEqual(queries.at(-1).params, [42]);

  // No warnings, no field; a lookup that fails never fails the declaration.
  stub(t, shotsIdentities, 'personaWarnings', async () => []);
  assert.equal(Object.hasOwn((await declare(url, intent)).body, 'warnings'), false);
  stub(t, shotsIdentities, 'personaWarnings', async () => { throw new Error('visibility lookup failed'); });
  const failedLookup = await declare(url, intent);
  assert.equal(failedLookup.status, 200);
  assert.equal(failedLookup.body.ok, true);
  assert.equal(Object.hasOwn(failedLookup.body, 'warnings'), false);
});

// #6815: a build that says nothing visible changes and has sent no diagram
// is told that the diagram is the only picture voters get. Advisory: the
// declaration always stands.
test('an impact-none declaration with no diagram is nudged toward one', async (t) => {
  stub(t, shotsState, 'recordIntent', async (_pool, sessionId, raw) => ({
    accepted: true, unchanged: false, required: false, state: 'not_required', intent: raw, runId: null, sessionId,
  }));
  const seen = [];
  stub(t, shotsIdentities, 'personaWarnings', async (_pool, app) => {
    seen.push(app);
    return ['persona first.'];
  });
  const original = appRow;
  t.after(() => { appRow = original; });
  const url = await serve(t);
  const none = { version: 1, impact: 'none', rationale: 'Server only.', stories: [] };

  appRow = { id: 7, slug: 'vote-inbox', has_diagram: false };
  const missing = await declare(url, none);
  assert.equal(missing.status, 200);
  assert.equal(missing.body.ok, true, 'the declaration is never refused');
  assert.deepEqual(missing.body.warnings, ['persona first.', IMPACT_NONE_DIAGRAM_NUDGE]);
  assert.deepEqual(seen.at(-1), { id: 7, slug: 'vote-inbox' }, 'personaWarnings still reads the app alone');

  // A diagram already sent (even one declared first) means nothing to ask.
  appRow = { id: 7, slug: 'vote-inbox', has_diagram: true };
  const kept = (await declare(url, none)).body;
  assert.deepEqual(kept.warnings, ['persona first.'], 'a stored diagram leaves the nudge out');

  // A visible change is not asked: its shots are its picture.
  appRow = { id: 7, slug: 'vote-inbox', has_diagram: false };
  const ui = (await declare(url, { version: 1, impact: 'ui', rationale: 'A line.',
    stories: [{ id: 'summary-line', persona: 'member', claim: 'A line.', viewports: [{ name: 'desktop', width: 1280, height: 900 }],
      intent: { startPath: '/', steps: ['Open Home'], checkpoint: 'Shown', focus: 'The line', animation: 'none' } }] })).body;
  assert.deepEqual(ui.warnings, ['persona first.']);

  // A lookup that fails sends no reminder, and still answers 200.
  stub(t, shotsIdentities, 'personaWarnings', async () => { throw new Error('visibility lookup failed'); });
  const failed = await declare(url, none);
  assert.equal(failed.status, 200);
  assert.equal(failed.body.ok, true);
  assert.equal(Object.hasOwn(failed.body, 'warnings'), false);
});

test('a recorded declaration says what data the copies hold, and warns when a change needs a state they lack', async (t) => {
  stub(t, shotsState, 'recordIntent', async (_pool, sessionId, raw) => ({
    accepted: true, unchanged: false, required: true, state: 'planned', intent: raw, runId: null, sessionId,
  }));
  stub(t, shotsIdentities, 'personaWarnings', async () => ['persona first.']);
  const url = await serve(t);
  const story = (id, claim, intent = {}) => ({
    id, persona: 'member', claim, intent: { startPath: '/', steps: ['Open Home'], checkpoint: 'Shown', ...intent },
  });
  const intent = {
    version: 1, impact: 'ui', rationale: 'Two changes.',
    stories: [
      story('waitlist-card', 'A member on the waitlist sees when they get in.'),
      story('approval-chip', 'A request waiting for approval offers no Build it now.'),
    ],
  };

  // Homeroom's own proposal: the ready-made states, and a warning for the
  // one change whose state none of them holds, after the persona warnings.
  const original = appRow;
  t.after(() => { appRow = original; });
  appRow = { id: 1, slug: 'usernode-self' };
  const own = (await declare(url, intent)).body;
  assert.ok(own.availableStates.some((state) => /waits for approval/.test(state.name)));
  assert.match(own.dataNote, /src\/db\/migrate\.js/);
  assert.equal(own.warnings.length, 2);
  assert.equal(own.warnings[0], 'persona first.');
  assert.match(own.warnings[1], /^waitlist-card seems to need an account on the waitlist/);

  // A child app has no ready-made states: both changes are warned about.
  appRow = { id: 7, slug: 'vote-inbox' };
  const child = (await declare(url, intent)).body;
  assert.deepEqual(child.availableStates, []);
  assert.match(child.dataNote, /IS_STAGING/);
  assert.equal(child.warnings.length, 3);

  // Nothing to shoot, nothing to say about data. (A diagram is already stored,
  // so the #6815 reminder does not add a warning of its own.)
  stub(t, shotsIdentities, 'personaWarnings', async () => []);
  appRow = { id: 7, slug: 'vote-inbox', has_diagram: true };
  const none = (await declare(url, { version: 1, impact: 'none', rationale: 'Server only.', stories: [] })).body;
  assert.equal(Object.hasOwn(none, 'availableStates'), false);
  assert.equal(Object.hasOwn(none, 'warnings'), false);
});
