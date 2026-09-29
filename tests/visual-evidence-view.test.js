'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const view = require('../src/services/visual-evidence-view');

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const ARTIFACT = 'd'.repeat(32);

function session(overrides = {}) {
  return {
    id: 42,
    source: 'native',
    reviewed_head_sha: HEAD,
    visual_evidence_state: 'verified',
    visual_evidence_detail: {
      impact: 'ui',
      rationale: 'The dialog changed.',
      headSha: HEAD,
    },
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    state: 'verified',
    required: true,
    claims: [{
      id: 'dialog', claim: 'The dialog shows suggestions.', persona: 'member',
      viewports: ['desktop'], steps: ['Open dialog'], baseState: 'present', animation: 'none',
    }],
    baseSha: BASE,
    headSha: HEAD,
    failureCode: null,
    failureReason: null,
    repairAvailable: false,
    planHash: 'e'.repeat(64),
    replayCount: 2,
    repairCount: 1,
    relativePointer: true,
    verifiedReason: 'The paired images show the claimed state.',
    artifactSummary: [{
      id: ARTIFACT, storyId: 'dialog', viewport: 'desktop', side: 'head',
      variant: 'focus', media: 'png', contentType: 'image/png', bytes: 120,
    }],
    ...overrides,
  };
}

test('verified evidence exposes only authenticated artifact metadata for the exact head', () => {
  const result = view.serialize(run(), session(), 'demo-app', HEAD);
  assert.equal(result.state, 'verified');
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].url,
    `/api/apps/demo-app/proposals/42/evidence/${ARTIFACT}`);
  assert.equal(Object.hasOwn(result.artifacts[0], 'data'), false);
  assert.equal(result.claims[0].baseState, 'present');
  assert.equal(result.replayCount, 2);
  assert.equal(result.repairCount, 1);
  assert.equal(result.relativePointer, true);
});

test('a newer head makes the whole set stale and suppresses every artifact', () => {
  const result = view.serialize(run(), session({ reviewed_head_sha: OTHER }), 'demo-app', OTHER);
  assert.equal(result.state, 'stale');
  assert.equal(result.failureCode, 'superseded');
  assert.deepEqual(result.artifacts, []);
  assert.match(result.failureReason, /newer proposal revision/i);
});

test('pending, failed, and malformed artifact rows never leak media URLs', () => {
  for (const state of ['planned', 'failed', 'reviewing']) {
    const result = view.serialize(run({ state }), session({ visual_evidence_state: state }), 'demo-app', HEAD);
    assert.deepEqual(result.artifacts, [], state);
  }
  assert.deepEqual(view.cleanArtifacts([{ ...run().artifactSummary[0], id: '../secret' }], {
    slug: 'demo-app', sessionId: 42, verified: true,
  }), []);
});

test('active progress shows the last stage only for the current proposal head', () => {
  const progress = { phase: 'build_revisions', at: '2026-09-22T18:42:00Z' };
  const active = run({ state: 'provisioning', progress });
  assert.deepEqual(view.serialize(active, session(), 'demo-app', HEAD).progress, progress);
  assert.equal(view.serialize(active, session({ reviewed_head_sha: OTHER }), 'demo-app', OTHER).progress, null);
});

test('snapshot serialization is truthful before a durable run exists', () => {
  const result = view.fromSnapshot(session({
    visual_evidence_state: 'planned',
    visual_evidence_detail: {
      required: true, impact: 'ui', rationale: 'Visible change', headSha: HEAD,
      claims: [{
        id: 'new-screen', claim: 'A new route is available.', persona: 'member',
        viewports: ['mobile'], steps: ['Open the route'], baseState: 'not_present', animation: 'none',
      }],
    },
  }), HEAD);
  assert.equal(result.state, 'planned');
  assert.equal(result.claims[0].baseState, 'not_present');
  assert.deepEqual(result.artifacts, []);
});

// ── #2601/#2558: the run that never started ──────────────────────────────
test('a planned run carries the recorded reason it never started, as its own field', () => {
  const s = session({
    visual_evidence_state: 'planned',
    visual_evidence_detail: {
      impact: 'ui',
      headSha: HEAD,
      notStartedReason: 'Visual change previews are not being run on this deployment.',
    },
  });
  const snapshot = view.fromSnapshot(s, HEAD);
  assert.equal(snapshot.state, 'planned');
  assert.equal(snapshot.notStartedReason,
    'Visual change previews are not being run on this deployment.');
  // It is a SIBLING of failureReason, not a reuse of it: a run that never
  // started has not failed, and the two reach different copy.
  assert.equal(snapshot.failureReason, null);

  const serialized = view.serialize(run({ state: 'planned', headSha: HEAD }), s, 'demo', HEAD);
  assert.equal(serialized.notStartedReason,
    'Visual change previews are not being run on this deployment.');
});

test('the not-started reason is dropped once the run moves on, and on a superseded revision', () => {
  const detail = {
    impact: 'ui',
    headSha: HEAD,
    notStartedReason: 'Visual change previews are not being run on this deployment.',
  };
  // A run under way owns its own state; a note about it not starting is
  // stale the moment it does.
  assert.equal(view.notStartedReason(
    { visual_evidence_state: 'exploring', visual_evidence_detail: detail }, false
  ), null);
  assert.equal(view.notStartedReason(
    { visual_evidence_state: 'verified', visual_evidence_detail: detail }, false
  ), null);
  // A newer revision superseded the attempt the note describes.
  assert.equal(view.notStartedReason(
    { visual_evidence_state: 'planned', visual_evidence_detail: detail }, true
  ), null);
  assert.equal(view.notStartedReason(
    { visual_evidence_state: 'planned', visual_evidence_detail: detail }, false
  ), detail.notStartedReason);
});

test('a planned run with nothing recorded reports no reason rather than an empty string', () => {
  const snapshot = view.fromSnapshot(session({
    visual_evidence_state: 'planned',
    visual_evidence_detail: { impact: 'ui', headSha: HEAD, notStartedReason: '   ' },
  }), HEAD);
  assert.equal(snapshot.notStartedReason, null);
});

test('capture-mode runs expose per-claim results only while verified for the current head', () => {
  const view = require('../src/services/visual-evidence-view');
  const state = require('../src/services/visual-evidence-state');
  const row = {
    state: 'verified', base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), plan_hash: 'c'.repeat(64),
    intent: null, trace_summary: { runs: 1 },
    hard_verdict: { passed: true, mode: 'agent_capture', runs: 1, stories: [
      { id: 'dialog', status: 'captured', captures: 2 },
      { id: 'empty', status: 'blocked', reason: 'No list exists for this persona.' },
    ] },
  };
  const summary = state.runSummary(row);
  assert.equal(summary.captureMode, true);
  assert.equal(summary.replayCount, 1);
  const session = { id: 42, visual_evidence_detail: {} };
  const current = view.serialize(summary, session, 'demo', 'b'.repeat(40));
  assert.equal(current.captureMode, true);
  assert.deepEqual(current.claimResults, [
    { id: 'dialog', status: 'captured', reason: null },
    { id: 'empty', status: 'blocked', reason: 'No list exists for this persona.' },
  ]);
  assert.deepEqual(view.serialize(summary, session, 'demo', 'd'.repeat(40)).claimResults, [],
    'a superseded run publishes no per-claim results');
  const replayRun = state.runSummary({ ...row, hard_verdict: { passed: true, runs: 2, stories: [] } });
  assert.equal(replayRun.captureMode, false);
  assert.deepEqual(replayRun.claimResults, []);
  assert.deepEqual(view.fromSnapshot({ visual_evidence_state: 'planned', visual_evidence_detail: { required: true } }, null).claimResults, []);
});
