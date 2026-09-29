'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const proposalUpdate = require('../src/services/proposal-update');
const evidenceState = require('../src/services/visual-evidence-state');
const handoff = require('../src/routes/proposal-handoff');
const votes = require('../src/routes/votes');
const contract = require('../src/services/visual-evidence-plan');
const { intent, motionIntent } = require('./fixtures/visual-evidence');

const HEAD = 'a'.repeat(40);

test('submission response fields are explicit about acceptance, requirement, and next action', () => {
  assert.deepEqual(proposalUpdate.visualEvidenceSubmissionFields({
    accepted: true, rejected: false, required: true, state: 'planned',
  }), {
    visualEvidenceState: 'planned',
    visualEvidenceAccepted: true,
    visualEvidenceRejected: false,
    visualEvidenceRequired: true,
    visualEvidenceNextStep: 'await_visual_evidence',
  });
  assert.equal(proposalUpdate.visualEvidenceNextStep('failed', { required: true }),
    'rerun_or_correct_visual_evidence');
  assert.equal(proposalUpdate.visualEvidenceNextStep(null, { rejected: true }),
    'retry_visual_evidence_intent');
});

test('a disabled collector rejects a supplied declaration instead of pretending it was stored', async () => {
  const result = await proposalUpdate.applyVisualEvidenceRevision({
    pool: {},
    config: { visualEvidence: { collect: false } },
    session: { id: 42, visual_evidence_state: null, visual_evidence_detail: null },
    headSha: HEAD,
    visualEvidence: intent(),
    headChanged: true,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.rejected, true);
  assert.equal(result.changed, false);
  assert.equal(result.nextStep, 'visual_evidence_collection_disabled');
});

test('a head-changing update stales old evidence before recording the preserved declaration', async () => {
  const originalStale = evidenceState.markStaleForHead;
  const originalRecord = evidenceState.recordIntent;
  const calls = [];
  try {
    evidenceState.markStaleForHead = async (_pool, sessionId, headSha) => {
      calls.push(['stale', sessionId, headSha]);
    };
    evidenceState.recordIntent = async (_pool, sessionId, parsed, options) => {
      calls.push(['record', sessionId, parsed.impact, options.headSha]);
      return {
        accepted: true, unchanged: false, required: true, state: 'planned',
        detail: { intent: parsed, required: true, headSha: options.headSha }, runId: null,
      };
    };
    const session = {
      id: 42,
      visual_evidence_state: 'verified',
      visual_evidence_detail: { intent: intent(), required: true, headSha: 'b'.repeat(40) },
    };
    const result = await proposalUpdate.applyVisualEvidenceRevision({
      pool: {}, config: { visualEvidence: { collect: true } }, session,
      headSha: HEAD, visualEvidence: undefined, headChanged: true,
    });
    assert.deepEqual(calls.map((call) => call[0]), ['stale', 'record']);
    assert.equal(result.accepted, false, 'preserved intent was not falsely reported as newly submitted');
    assert.equal(result.rejected, false);
    assert.equal(result.required, true);
    assert.equal(result.state, 'planned');
    assert.equal(result.nextStep, 'await_visual_evidence');
  } finally {
    evidenceState.markStaleForHead = originalStale;
    evidenceState.recordIntent = originalRecord;
  }
});

test('native handoff build requests accept the same strictly parsed visual intent', () => {
  const parsed = handoff.parseBuildBody({
    schemaVersion: 1,
    headSha: HEAD,
    history: [],
    tests: [],
    visualEvidence: intent(),
  });
  assert.equal(parsed.visualEvidence.impact, 'ui');
  assert.equal(parsed.visualEvidence.stories[0].intent.baseState, 'present');
  const bad = intent();
  bad.stories[0].intent.startPath = 'https://evil.example';
  assert.throws(() => handoff.parseBuildBody({
    schemaVersion: 1, headSha: HEAD, history: [], tests: [], visualEvidence: bad,
  }), /relative in-app path/);
});

test('PR import records the declaration on its existing transaction client', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/votes.js'), 'utf8');
  const transaction = source.slice(
    source.indexOf("const importClient = await pool.connect()"),
    source.indexOf("const sessionId = inserted[0].id")
  );
  assert.match(transaction,
    /recordIntentInTransaction\(\s*importClient,\s*inserted\[0\]\.id,\s*importVisualEvidence/,
    'the uncommitted session row and its evidence are written atomically');
  assert.doesNotMatch(transaction, /recordIntent\(\s*importClient/,
    'the pool-owning helper must not receive an already checked-out PoolClient');
  // The declaration is all an import stores. The preview agent's run is
  // created later from it; no author-supplied plan or run rides the import.
  assert.doesNotMatch(transaction, /createRunInTransaction|authorPlan|visualEvidencePlan/);
});

test('PR import parses only the declaration; an author plan in the body is ignored', () => {
  const declared = motionIntent();
  const stalePlan = { baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), planHash: 'c'.repeat(64), plan: {} };
  assert.deepEqual(
    votes.parseImportVisualEvidence({ visualEvidence: declared, visualEvidencePlan: stalePlan }),
    contract.parseIntent(declared),
    'the strict v1 parser owns the import boundary, whatever else the body carries'
  );
  // Absent stays absent, so a browser import writes exactly what it did.
  assert.equal(votes.parseImportVisualEvidence({ visualEvidencePlan: stalePlan }), undefined);
  assert.equal(votes.parseImportVisualEvidence(undefined), undefined);
  // An invalid declaration is still refused rather than stored.
  const bad = intent();
  bad.stories[0].intent.startPath = 'https://evil.example';
  assert.throws(() => votes.parseImportVisualEvidence({ visualEvidence: bad }), /relative in-app path/);
  assert.equal(votes.parseImportVisualEvidencePlan, undefined, 'the plan parser is gone');
});

test('PR import evidence failures expose a safe stage and field without leaking the database error', () => {
  const err = new Error('password=not-for-callers');
  err.prImportStage = 'visual_evidence_intent';
  err.prImportField = 'visualEvidence';
  const body = votes.prImportFailureBody(err);
  assert.deepEqual(body, {
    error: 'PR import failed while recording visualEvidence.',
    stage: 'visual_evidence_intent',
    field: 'visualEvidence',
    retryable: true,
  });
  assert.doesNotMatch(JSON.stringify(body), /password/);
  assert.deepEqual(votes.prImportFailureBody(new Error('private')), {
    error: 'Internal server error',
  });
  // The import no longer records a plan, so that stage is not a boundary a
  // caller can act on: it reads as any other internal failure.
  const planError = new Error('password=not-for-callers');
  planError.prImportStage = 'visual_evidence_plan';
  assert.deepEqual(votes.prImportFailureBody(planError), { error: 'Internal server error' });
});
