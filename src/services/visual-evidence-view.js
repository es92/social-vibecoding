'use strict';

// One public shape for every reviewer surface. Binary bytes, internal
// origins, fixture names, tokens, raw plans, and model transcripts never
// enter this view model.

const state = require('./visual-evidence-state');
const { visualHeadForSession } = require('./pr-vote-revision');

const PUBLIC_STATES = new Set([
  'planned', 'provisioning', 'exploring', 'replaying', 'reviewing',
  'verified', 'failed', 'not_required', 'overridden', 'stale', 'cancelled',
]);
const ARTIFACT_ID_RE = /^[0-9a-f]{32}$/;
const STORY_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,94}[a-z0-9])?$/;
const VIEWPORT_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
const MEDIA_TYPE = Object.freeze({ png: 'image/png', webm: 'video/webm', gif: 'image/gif' });

function cleanClaims(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).map((claim) => ({
    id: String(claim?.id || '').slice(0, 96),
    claim: String(claim?.claim || '').slice(0, 1000),
    persona: ['member', 'read_only_admin', 'full_admin'].includes(claim?.persona)
      ? claim.persona : 'member',
    viewports: Array.isArray(claim?.viewports)
      ? claim.viewports.slice(0, 2).map((name) => String(name).slice(0, 32))
      : [],
    steps: Array.isArray(claim?.steps)
      ? claim.steps.slice(0, 40).map((step) => String(step).slice(0, 200))
      : [],
    baseState: claim?.baseState === 'not_present' ? 'not_present' : 'present',
    animation: ['none', 'steps', 'motion'].includes(claim?.animation) ? claim.animation : 'none',
  })).filter((claim) => claim.id && claim.claim);
}

function artifactUrl(slug, sessionId, artifactId) {
  if (!ARTIFACT_ID_RE.test(String(artifactId || ''))) return null;
  return `/api/apps/${encodeURIComponent(slug)}/proposals/${Number(sessionId)}/evidence/${artifactId}`;
}

function cleanArtifacts(items, { slug, sessionId, verified }) {
  if (!verified || !Array.isArray(items)) return [];
  return items.slice(0, 36).filter((artifact) => {
    if (!artifact || !ARTIFACT_ID_RE.test(String(artifact.id || ''))
        || !STORY_ID_RE.test(String(artifact.storyId || ''))
        || !VIEWPORT_RE.test(String(artifact.viewport || ''))
        || !['base', 'head', 'paired'].includes(artifact.side)
        || !['focus', 'context', 'animation'].includes(artifact.variant)
        || !Object.hasOwn(MEDIA_TYPE, artifact.media)
        || artifact.contentType !== MEDIA_TYPE[artifact.media]) return false;
    if (artifact.variant === 'animation') return artifact.side === 'paired' && artifact.media !== 'png';
    return artifact.side !== 'paired' && artifact.media === 'png';
  }).map((artifact) => ({
    id: String(artifact.id || ''),
    storyId: String(artifact.storyId || '').slice(0, 96),
    viewport: String(artifact.viewport || '').slice(0, 32),
    side: ['base', 'head', 'paired'].includes(artifact.side) ? artifact.side : null,
    variant: ['focus', 'context', 'animation'].includes(artifact.variant) ? artifact.variant : null,
    media: ['png', 'webm', 'gif'].includes(artifact.media) ? artifact.media : null,
    contentType: String(artifact.contentType || '').slice(0, 32),
    width: Number.isInteger(artifact.width) ? artifact.width : null,
    height: Number.isInteger(artifact.height) ? artifact.height : null,
    bytes: Number.isInteger(artifact.bytes) ? artifact.bytes : null,
    focusRect: artifact.focusRect && typeof artifact.focusRect === 'object' ? artifact.focusRect : null,
    stageLabels: Array.isArray(artifact.stageLabels)
      ? artifact.stageLabels.slice(0, 40).map((label) => String(label).slice(0, 100))
      : null,
    url: artifactUrl(slug, sessionId, artifact.id),
  }));
}

// #2601/#2558: why a run that is still 'planned' never got under way, as
// `visual-evidence-orchestrator.noteNotStarted` recorded it on the proposal.
// A sibling of `failureReason` rather than a reuse of it: a run that never
// started has not failed, and the two words reach different copy. It is
// dropped once the run has moved on, and on a superseded revision, where it
// would describe a schedule attempt nobody is looking at any more.
function notStartedReason(session, superseded) {
  const detail = session?.visual_evidence_detail;
  if (superseded || session?.visual_evidence_state !== 'planned') return null;
  const value = detail && typeof detail === 'object' ? detail.notStartedReason : null;
  return typeof value === 'string' && value.trim() ? value.slice(0, 300) : null;
}

function fromSnapshot(session, currentHead) {
  const detail = session?.visual_evidence_detail;
  if (!detail || typeof detail !== 'object') return null;
  const recordedHead = typeof detail.headSha === 'string' ? detail.headSha : null;
  const mismatched = !!(recordedHead && currentHead && recordedHead !== currentHead);
  return {
    state: mismatched ? 'stale' : (PUBLIC_STATES.has(session.visual_evidence_state)
      ? session.visual_evidence_state : 'planned'),
    required: detail.required !== false,
    impact: ['ui', 'motion', 'none'].includes(detail.impact) ? detail.impact : null,
    rationale: typeof detail.rationale === 'string' ? detail.rationale.slice(0, 1000) : null,
    claims: cleanClaims(detail.claims),
    baseSha: typeof detail.baseSha === 'string' ? detail.baseSha : null,
    headSha: recordedHead,
    failureCode: typeof detail.failureCode === 'string' ? detail.failureCode : null,
    failureReason: mismatched
      ? 'A newer proposal revision superseded this evidence.'
      : (typeof detail.failureReason === 'string' ? detail.failureReason.slice(0, 2000) : null),
    notStartedReason: notStartedReason(session, mismatched),
    repairAvailable: detail.repairAvailable === true,
    planHash: typeof detail.planHash === 'string' ? detail.planHash : null,
    replayCount: Number.isInteger(detail.replayCount) ? Math.max(0, Math.min(2, detail.replayCount)) : null,
    repairCount: Number.isInteger(detail.repairCount) ? Math.max(0, Math.min(1, detail.repairCount)) : 0,
    relativePointer: detail.relativePointer === true,
    progress: null,
    verifiedReason: null,
    overriddenBy: Number.isInteger(detail.overriddenBy) ? detail.overriddenBy : null,
    overriddenAt: detail.overriddenAt || null,
    overrideReason: typeof detail.overrideReason === 'string' ? detail.overrideReason.slice(0, 1000) : null,
    artifacts: [],
    updatedAt: session.visual_evidence_updated_at || detail.updatedAt || null,
  };
}

function serialize(run, session, slug, currentHead) {
  if (!run) return fromSnapshot(session, currentHead);
  const matchesCurrent = !currentHead || run.headSha === currentHead;
  const publicState = matchesCurrent ? run.state : 'stale';
  return {
    state: PUBLIC_STATES.has(publicState) ? publicState : 'failed',
    required: run.required !== false,
    impact: session?.visual_evidence_detail?.impact || null,
    rationale: session?.visual_evidence_detail?.rationale || null,
    claims: cleanClaims(run.claims),
    baseSha: run.baseSha || null,
    headSha: run.headSha || null,
    failureCode: matchesCurrent ? (run.failureCode || null) : 'superseded',
    failureReason: matchesCurrent
      ? (run.failureReason || null)
      : 'A newer proposal revision superseded this evidence.',
    notStartedReason: notStartedReason(session, !matchesCurrent),
    repairAvailable: matchesCurrent && run.repairAvailable === true,
    planHash: run.planHash || null,
    replayCount: Number.isInteger(run.replayCount) ? Math.max(0, Math.min(2, run.replayCount)) : null,
    repairCount: Number.isInteger(run.repairCount) ? Math.max(0, Math.min(1, run.repairCount)) : 0,
    relativePointer: run.relativePointer === true,
    progress: matchesCurrent && PUBLIC_STATES.has(run.state) ? (run.progress || null) : null,
    verifiedReason: null,
    overriddenBy: run.overriddenBy || null,
    overriddenAt: run.overriddenAt || null,
    overrideReason: run.overrideReason || null,
    artifacts: cleanArtifacts(run.artifactSummary, {
      slug, sessionId: session.id, verified: matchesCurrent && run.state === 'verified',
    }),
    updatedAt: run.updatedAt || session.visual_evidence_updated_at || null,
  };
}

async function getForSession(pool, session, slug = session?.app_slug) {
  if (!session || !session.id || !slug) return null;
  const currentHead = visualHeadForSession(session);
  let run = null;
  if (currentHead) run = await state.getForSession(pool, Number(session.id), { headSha: currentHead });
  return serialize(run, session, slug, currentHead);
}

async function getForSessions(pool, sessions, slug) {
  const list = Array.isArray(sessions) ? sessions : [];
  const runIds = list.map((session) => session.visual_evidence_run_id).filter(Boolean);
  const bySession = new Map();
  if (runIds.length) {
    const { rows } = await pool.query(
      `SELECT r.*,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', a.id, 'storyId', a.story_id, 'viewport', a.viewport,
                  'side', a.side, 'variant', a.variant, 'media', a.media,
                  'contentType', a.content_type, 'width', a.width,
                  'height', a.height, 'bytes', a.bytes,
                  'focusRect', a.focus_rect, 'stageLabels', a.stage_labels
                ) ORDER BY a.story_id, a.viewport, a.side, a.variant)
                  FROM visual_evidence_artifacts a WHERE a.run_id = r.id
              ), '[]'::jsonb) AS artifact_summary
         FROM visual_evidence_runs r WHERE r.id = ANY($1::varchar[])`,
      [runIds]
    );
    for (const row of rows) bySession.set(Number(row.session_id), state.runSummary(row, row.artifact_summary || []));
  }
  const result = new Map();
  for (const session of list) {
    const currentHead = visualHeadForSession(session);
    result.set(Number(session.id), serialize(
      bySession.get(Number(session.id)) || null,
      session,
      slug || session.app_slug,
      currentHead
    ));
  }
  return result;
}

module.exports = {
  PUBLIC_STATES,
  cleanClaims,
  cleanArtifacts,
  artifactUrl,
  notStartedReason,
  fromSnapshot,
  serialize,
  getForSession,
  getForSessions,
};
