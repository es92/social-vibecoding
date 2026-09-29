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
    shotResults: [{ id: 'dialog', status: 'ready', reason: null }],
    verifiedReason: 'A model said the images show the claimed state.',
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
  assert.deepEqual(result.shotResults, [{ id: 'dialog', status: 'ready', reason: null }]);
  // People judge the shots; no model verdict is ever passed through.
  assert.equal(result.verifiedReason, null);
  for (const key of ['replayCount', 'repairCount', 'relativePointer', 'captureMode', 'claimResults']) {
    assert.equal(Object.hasOwn(result, key), false, key);
  }
});

test('a newer head makes the whole set stale and suppresses every artifact', () => {
  const result = view.serialize(run(), session({ reviewed_head_sha: OTHER }), 'demo-app', OTHER);
  assert.equal(result.state, 'stale');
  assert.equal(result.failureCode, 'superseded');
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.shotResults, []);
  assert.match(result.failureReason, /newer revision of this proposal/i);
});

test('pending, failed, and malformed artifact rows never leak media URLs', () => {
  for (const state of ['planned', 'failed', 'reviewing']) {
    const result = view.serialize(run({ state }), session({ visual_evidence_state: state }), 'demo-app', HEAD);
    assert.deepEqual(result.artifacts, [], state);
    assert.deepEqual(result.shotResults, [], state);
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
  assert.deepEqual(result.shotResults, []);
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

// ── Before/after shots: per-change results and clips ─────────────────────

test('shot results are exposed only for the verified run on the current head', () => {
  const state = require('../src/services/visual-evidence-state');
  const row = {
    state: 'verified', base_sha: BASE, head_sha: HEAD, plan_hash: 'c'.repeat(64),
    intent: null, trace_summary: { runs: 1 },
    hard_verdict: { passed: true, mode: 'shots', runs: 1, stories: [
      { id: 'dialog', status: 'ready', files: 2 },
      { id: 'empty', status: 'skipped', reason: 'No list exists for this persona.' },
    ] },
  };
  const summary = state.runSummary(row);
  const current = view.serialize(summary, session(), 'demo', HEAD);
  assert.deepEqual(current.shotResults, [
    { id: 'dialog', status: 'ready', reason: null },
    { id: 'empty', status: 'skipped', reason: 'No list exists for this persona.' },
  ]);
  assert.deepEqual(view.serialize(summary, session(), 'demo', OTHER).shotResults, [],
    'a superseded run publishes no per-change results');
  for (const active of ['exploring', 'reviewing', 'failed']) {
    assert.deepEqual(view.serialize({ ...summary, state: active }, session(), 'demo', HEAD).shotResults, [], active);
  }
  // A replay-era run has no per-change results.
  const replayRun = state.runSummary({ ...row, hard_verdict: { passed: true, runs: 2, stories: [] } });
  assert.deepEqual(view.serialize(replayRun, session(), 'demo', HEAD).shotResults, []);
  assert.deepEqual(view.fromSnapshot({ visual_evidence_state: 'planned', visual_evidence_detail: { required: true } }, null).shotResults, []);
});

test('shot results are cleaned before they reach any reviewer surface', () => {
  assert.deepEqual(view.cleanShotResults(null), []);
  assert.deepEqual(view.cleanShotResults('ready'), []);
  // Never more than the three changes a declaration may carry, and never an
  // id that is not a declared-change slug.
  assert.deepEqual(view.cleanShotResults([
    { id: '../escape', status: 'ready' }, { id: 'one', status: 'ready' },
    { id: 'two', status: 'ready' }, { id: 'three', status: 'ready' },
  ]).map(({ id }) => id), ['one', 'two']);
  const cleaned = view.cleanShotResults([
    { id: 'ready-one', status: 'ready', reason: 'ignored for a ready change', files: 4 },
    { id: 'odd-status', status: 'published', reason: 'Clipped. '.repeat(200) },
    { id: 'no-reason', status: 'skipped', reason: { html: '<b>x</b>' } },
  ]);
  assert.deepEqual(cleaned.map(({ id, status }) => [id, status]),
    [['ready-one', 'ready'], ['odd-status', 'skipped'], ['no-reason', 'skipped']]);
  assert.equal(cleaned[0].reason, null);
  assert.equal(cleaned[1].reason.length, 1000);
  assert.equal(cleaned[2].reason, null);
  for (const result of cleaned) assert.deepEqual(Object.keys(result).sort(), ['id', 'reason', 'status']);
});

function artifact(overrides = {}) {
  return {
    id: ARTIFACT, storyId: 'dialog', viewport: 'desktop', side: 'head',
    variant: 'context', media: 'png', contentType: 'image/png', bytes: 120,
    ...overrides,
  };
}

function kept(item) {
  return view.cleanArtifacts([item], { slug: 'demo-app', sessionId: 42, verified: true });
}

test('a clip is one WebM per side; a legacy paired animation still plays', () => {
  for (const side of ['base', 'head']) {
    const [clip] = kept(artifact({ side, variant: 'animation', media: 'webm', contentType: 'video/webm' }));
    assert.ok(clip, side);
    assert.equal(clip.side, side);
    assert.equal(clip.media, 'webm');
    assert.equal(clip.url, `/api/apps/demo-app/proposals/42/evidence/${ARTIFACT}`);
  }
  // Runs from before shots stored one paired before/after recording.
  for (const [media, contentType] of [['webm', 'video/webm'], ['gif', 'image/gif']]) {
    assert.equal(kept(artifact({ side: 'paired', variant: 'animation', media, contentType })).length, 1, media);
  }
  assert.equal(kept(artifact({ variant: 'focus' })).length, 1);
  assert.equal(kept(artifact({ side: 'base' })).length, 1);
});

test('mismatched media is refused: no PNG animation, no WebM shot, no paired still', () => {
  for (const [label, item] of [
    ['png animation', artifact({ variant: 'animation', media: 'png' })],
    ['paired png animation', artifact({ side: 'paired', variant: 'animation', media: 'png' })],
    ['gif clip on one side', artifact({ variant: 'animation', media: 'gif', contentType: 'image/gif' })],
    ['webm context', artifact({ variant: 'context', media: 'webm', contentType: 'video/webm' })],
    ['webm focus', artifact({ variant: 'focus', media: 'webm', contentType: 'video/webm' })],
    ['paired still', artifact({ side: 'paired' })],
    ['content type disagrees', artifact({ variant: 'animation', media: 'webm', contentType: 'image/png' })],
    ['unknown side', artifact({ side: 'before' })],
    ['unknown variant', artifact({ variant: 'clip', media: 'webm', contentType: 'video/webm' })],
  ]) {
    assert.deepEqual(kept(item), [], label);
  }
  assert.deepEqual(view.cleanArtifacts([artifact({ variant: 'animation', media: 'webm', contentType: 'video/webm' })], {
    slug: 'demo-app', sessionId: 42, verified: false,
  }), [], 'an unverified run serves no clip');
});
