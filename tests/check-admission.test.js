'use strict';

// services/check-admission — which half of a checks run a proposal gets.
//
// The preview (build + screenshots) is for reviewers and always runs. The
// verdict (dapp.json assertions + the unit suite) is for the merge gate, and
// a promoted head that CONFLICTS with main cannot merge as it stands, so a
// verdict about it judges a tree that never lands. It is held back —
// 'shots_only' — until the head measures clean. Everything that is not that
// exact case fails OPEN to the full run: a wrong deferral costs a verdict, a
// wrong full run costs compute.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const integration = require('../src/services/integration');
const admission = require('../src/services/check-admission');

const HEAD = 'a'.repeat(40);
const pool = { query: async () => ({ rows: [] }) };

function stubMeasure(fn) {
  const real = integration.measureDeduped;
  const calls = [];
  integration.measureDeduped = async (deps, opts) => { calls.push({ deps, opts }); return fn(deps, opts); };
  return { calls, restore: () => { integration.measureDeduped = real; } };
}

test('a draft is never deferred: its checks are the author\'s feedback, not the gate', async () => {
  const m = stubMeasure(async () => ({ mergesClean: false, headSha: HEAD }));
  try {
    const out = await admission.decide({ pool, session: { id: 1, status: 'active' } });
    assert.deepEqual(out, { mode: 'full', reason: 'not_promoted' });
    assert.equal(m.calls.length, 0, 'nothing is measured for a row that cannot be deferred');
  } finally { m.restore(); }
});

test('a human pressing Re-run gets the run they asked for, conflict or not', async () => {
  const m = stubMeasure(async () => ({ mergesClean: false, headSha: HEAD }));
  try {
    const out = await admission.decide({
      pool, session: { id: 1, status: 'promoted' }, trigger: 'manual-recheck',
    });
    assert.deepEqual(out, { mode: 'full', reason: 'manual' });
    assert.equal(m.calls.length, 0);
    assert.ok(admission.MANUAL_TRIGGERS.has('manual-recheck'));
  } finally { m.restore(); }
});

test('a promoted head that conflicts with main gets the preview and no verdict', async () => {
  const measured = { mergesClean: false, headSha: HEAD, conflictPaths: ['dapp.json'] };
  const m = stubMeasure(async () => measured);
  try {
    const out = await admission.decide({
      pool, session: { id: 7, status: 'promoted', repo_url: 'https://github.com/o/r', branch_name: 'b' },
      commitHash: HEAD, trigger: 'promote-kick',
    });
    assert.equal(out.mode, 'shots_only');
    assert.equal(out.reason, 'conflict');
    assert.equal(out.measured, measured, 'the measurement rides along for the log line');
    // Forced: a fresh answer, not the cached one from a minute before the
    // sibling merge that may have changed it.
    assert.equal(m.calls[0].opts.force, true);
  } finally { m.restore(); }
});

test('a promoted head that merges cleanly gets the full run', async () => {
  const m = stubMeasure(async () => ({ mergesClean: true, headSha: HEAD }));
  try {
    const out = await admission.decide({
      pool, session: { id: 7, status: 'promoted' }, commitHash: HEAD,
    });
    assert.equal(out.mode, 'full');
    assert.equal(out.reason, 'clean');
  } finally { m.restore(); }
});

test('the answer has to be about the commit being captured', async () => {
  // The branch moved between the build and the capture: a measurement of
  // the newer head says nothing about the tree in the container.
  const m = stubMeasure(async () => ({ mergesClean: false, headSha: 'b'.repeat(40) }));
  try {
    const out = await admission.decide({
      pool, session: { id: 7, status: 'promoted' }, commitHash: HEAD,
    });
    assert.equal(out.mode, 'full');
    assert.equal(out.reason, 'head_mismatch');
    // Case is not a difference.
    const same = stubMeasure(async () => ({ mergesClean: false, headSha: HEAD.toUpperCase() }));
    try {
      const again = await admission.decide({ pool, session: { id: 7, status: 'promoted' }, commitHash: HEAD });
      assert.equal(again.mode, 'shots_only');
    } finally { same.restore(); }
  } finally { m.restore(); }
});

test('every way the measurement can fail to answer runs the full suite', async () => {
  const cases = [
    [async () => { throw new Error('mirror gone'); }, 'measure_threw'],
    [async () => ({ error: 'branch b is not in the mirror' }), 'measure_error'],
    [async () => ({ skipped: 'incomplete_session' }), 'incomplete_session'],
    [async () => null, 'unmeasured'],
    [async () => ({ mergesClean: null, headSha: HEAD }), 'clean'],
  ];
  for (const [fn, reason] of cases) {
    const m = stubMeasure(fn);
    try {
      const out = await admission.decide({ pool, session: { id: 7, status: 'promoted' }, commitHash: HEAD });
      assert.equal(out.mode, 'full', reason);
      assert.equal(out.reason, reason);
    } finally { m.restore(); }
  }
  // No pool at all: nothing to measure with.
  const m = stubMeasure(async () => ({ mergesClean: false, headSha: HEAD }));
  try {
    assert.deepEqual(await admission.decide({ pool: null, session: { id: 7, status: 'promoted' } }),
      { mode: 'full', reason: 'no_pool' });
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test('the repo comes off the app descriptor when the session row does not carry it', async () => {
  const m = stubMeasure(async () => ({ mergesClean: true, headSha: HEAD }));
  try {
    await admission.decide({
      pool, session: { id: 7, status: 'promoted', branch_name: 'b' },
      app: { repo_url: 'https://github.com/o/r' }, commitHash: HEAD,
    });
    assert.equal(m.calls[0].deps.session.repo_url, 'https://github.com/o/r');
    assert.equal(m.calls[0].deps.pool, pool);
    // ...but a row that has one keeps its own.
    await admission.decide({
      pool, session: { id: 7, status: 'promoted', repo_url: 'https://github.com/x/y' },
      app: { repo_url: 'https://github.com/o/r' },
    });
    assert.equal(m.calls[1].deps.session.repo_url, 'https://github.com/x/y');
  } finally { m.restore(); }
});
