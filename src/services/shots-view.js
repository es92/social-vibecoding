'use strict';

// One public shape for every reviewer surface. Binary bytes, internal
// origins, fixture names, tokens, and model transcripts never enter this
// view model.

const state = require('./shots-state');
const shotsFiles = require('./shots-files');
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
    persona: ['member', 'read_only_admin', 'full_admin', 'guest', 'invited_member', 'invited_member_listed'].includes(claim?.persona)
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

// One result per declared change: its shots are ready, or unchanged (shown,
// but its before and after came out the same, and its note says so), or the
// shots agent skipped it and says why, or it failed: the agent did the steps
// and the after build broke.
// The agent sometimes writes a quotation mark already escaped, as it would
// inside JSON (\"Continue\"); people should read the quotation mark.
const unescapeQuotes = (text) => text.replace(/\\+(["'])/g, '$1');
const SHOWN_RESULTS = new Set(['ready', 'unchanged']);

// A result carries `conditions` only when the shots agent did something to
// both builds to reach the change: an API GET it held or made fail, or
// sample files it uploaded, each from a fixed shape (shots-files.condition).
function cleanShotResults(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).filter((result) => STORY_ID_RE.test(String(result?.id || '')))
    .map((result) => {
      const status = SHOWN_RESULTS.has(result.status) || result.status === 'failed' ? result.status : 'skipped';
      const shown = SHOWN_RESULTS.has(status);
      const conditions = shotsFiles.cleanConditions(result.conditions);
      return {
        id: String(result.id),
        status,
        reason: shown || typeof result.reason !== 'string'
          ? null : unescapeQuotes(result.reason).slice(0, 1000),
        note: !shown || typeof result.note !== 'string'
          ? null : unescapeQuotes(result.note).slice(0, 500),
        ...(conditions.length ? { conditions } : {}),
      };
    });
}

// What the shots agent noticed broken on the after build besides the
// declared changes: a handful of short notes, each where it shows (one of
// this run's declared changes and a screen name), which after shot shows it
// if one does, and whether the before build has it too. Advisory: shown
// under "Also noticed" and nothing else reads them.
function cleanShotNotices(value, claims) {
  if (!Array.isArray(value)) return [];
  const ids = new Set((claims || []).map((claim) => claim.id));
  return value.filter((entry) => entry && typeof entry.text === 'string' && entry.text.trim()
    && ids.has(entry.change) && VIEWPORT_RE.test(String(entry.screen || '')))
    .slice(0, 5).map((entry) => ({
      text: unescapeQuotes(entry.text.trim()).slice(0, 300),
      change: entry.change,
      screen: entry.screen,
      shot: entry.shot === 'screen' || entry.shot === 'element' ? entry.shot : null,
      alsoBefore: entry.alsoBefore === true || entry.alsoBefore === false ? entry.alsoBefore : 'unknown',
    }));
}

// The screens a verified run's card shows, and the areas that differ on
// each: integers and story ids from this run's own declaration, nothing else.
function cleanScreens(screens, claims) {
  const ids = new Set((claims || []).map((claim) => claim.id));
  const int = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 20000;
  const box = (value, size) => (Array.isArray(value) && value.length === size && value.every(int)
    ? value.slice() : null);
  return (Array.isArray(screens) ? screens : []).slice(0, 6)
    .filter((screen) => screen && typeof screen.viewport === 'string' && ids.has(screen.shot))
    .map((screen) => ({
      viewport: screen.viewport.slice(0, 32),
      shot: screen.shot,
      stories: (Array.isArray(screen.stories) ? screen.stories : []).filter((id) => ids.has(id)).slice(0, 3),
      width: int(screen.width) ? screen.width : null,
      heightBefore: int(screen.heightBefore) ? screen.heightBefore : null,
      heightAfter: int(screen.heightAfter) ? screen.heightAfter : null,
      regions: (Array.isArray(screen.regions) ? screen.regions : []).slice(0, 12)
        .map((region) => ({
          story: region && ids.has(region.story) ? region.story : null,
          b: box(region?.b, 4),
          a: box(region?.a, 4),
          bMark: box(region?.bMark, 3),
          aMark: box(region?.aMark, 3),
        }))
        .filter((region) => region.b || region.a),
    }));
}

// A dense still's own address (`?density=device`) is a different address,
// so a browser that cached one copy never answers for the other.
function artifactUrl(slug, sessionId, artifactId, { dense = false } = {}) {
  if (!ARTIFACT_ID_RE.test(String(artifactId || ''))) return null;
  return `/api/apps/${encodeURIComponent(slug)}/proposals/${Number(sessionId)}/shots/${artifactId}${dense ? '?density=device' : ''}`;
}

// A still kept at device density as well (services/shots-density.js): its
// density and its original's size, or null for every other artifact.
function denseOf(artifact) {
  const density = Number(artifact?.density);
  return artifact?.media === 'png' && [2, 3, 4].includes(density)
    && Number.isInteger(artifact.denseWidth) && Number.isInteger(artifact.denseHeight)
    ? { density, width: artifact.denseWidth, height: artifact.denseHeight } : null;
}

// `dense`: the viewer is in the New Needs you experiment, the only accounts
// shown stills at device density. Everyone else is shown each still's 1x
// copy, its size and `density: 1`, exactly what they were shown before.
// A close-up (services/shots-closeups.js): the after side of a change on
// one screen, `rect` the region of that change's after screen shot it shows
// (CSS px), `density` its device px per CSS px (one decimal), `width` and
// `height` its own pixels. Null for anything malformed.
const wholePx = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 20000;
function cleanCloseup(artifact, { slug, sessionId }) {
  const rect = artifact?.focusRect;
  const density = Math.round(Number(artifact?.scale) * 10) / 10;
  if (!ARTIFACT_ID_RE.test(String(artifact?.id || '')) || !STORY_ID_RE.test(String(artifact.storyId || ''))
      || !VIEWPORT_RE.test(String(artifact.viewport || '')) || artifact.side !== 'head' || artifact.media !== 'png'
      || artifact.contentType !== MEDIA_TYPE.png || ![1, 2].includes(artifact.part)
      || !(density > 1 && density <= 16) || !rect || !['x', 'y', 'w', 'h'].every((key) => wholePx(rect[key]))
      || rect.w < 1 || rect.h < 1 || !wholePx(artifact.width) || !wholePx(artifact.height)) return null;
  return {
    id: artifact.id, storyId: artifact.storyId, viewport: artifact.viewport,
    side: 'head', variant: 'closeup', media: 'png', theme: 'light', contentType: MEDIA_TYPE.png,
    part: artifact.part, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    width: artifact.width, height: artifact.height, density,
    bytes: Number.isInteger(artifact.bytes) ? artifact.bytes : null,
    url: artifactUrl(slug, sessionId, artifact.id, { dense: true }),
  };
}

function cleanArtifacts(items, { slug, sessionId, verified, dense = false }) {
  if (!verified || !Array.isArray(items)) return [];
  // Close-ups are shown only to an account in the New Needs you
  // experiment, beside the stills, never in their place.
  const closeups = dense ? items.filter((artifact) => artifact?.variant === 'closeup')
    .map((artifact) => cleanCloseup(artifact, { slug, sessionId })).filter(Boolean).slice(0, 6) : [];
  // Up to 48: three changes more than the old 36, the room a run's dark
  // shots (#4459) take beside their light ones.
  return items.filter((artifact) => artifact?.variant !== 'closeup').slice(0, 48).filter((artifact) => {
    if (!artifact || !ARTIFACT_ID_RE.test(String(artifact.id || ''))
        || !STORY_ID_RE.test(String(artifact.storyId || ''))
        || !VIEWPORT_RE.test(String(artifact.viewport || ''))
        || !['base', 'head', 'paired'].includes(artifact.side)
        || !['focus', 'context', 'animation'].includes(artifact.variant)
        || !Object.hasOwn(MEDIA_TYPE, artifact.media)
        || artifact.contentType !== MEDIA_TYPE[artifact.media]) return false;
    // A clip is one recording per side; older runs stored one paired
    // before/after animation instead.
    if (artifact.variant === 'animation') {
      return artifact.side === 'paired' ? artifact.media !== 'png' : artifact.media === 'webm';
    }
    return artifact.side !== 'paired' && artifact.media === 'png';
  }).map((artifact) => {
    const sharp = dense ? denseOf(artifact) : null;
    return {
      id: String(artifact.id || ''),
      storyId: String(artifact.storyId || '').slice(0, 96),
      viewport: String(artifact.viewport || '').slice(0, 32),
      side: ['base', 'head', 'paired'].includes(artifact.side) ? artifact.side : null,
      variant: ['focus', 'context', 'animation'].includes(artifact.variant) ? artifact.variant : null,
      media: ['png', 'webm', 'gif'].includes(artifact.media) ? artifact.media : null,
      // A dark artifact exists only as a whole-screen PNG; anything else reads
      // as light, which is what every row before the column held.
      theme: artifact.theme === 'dark' && artifact.variant === 'context' && artifact.media === 'png'
        ? 'dark' : 'light',
      contentType: String(artifact.contentType || '').slice(0, 32),
      // The file's own pixels; divided by `density` they are CSS pixels.
      width: sharp ? sharp.width : Number.isInteger(artifact.width) ? artifact.width : null,
      height: sharp ? sharp.height : Number.isInteger(artifact.height) ? artifact.height : null,
      density: sharp ? sharp.density : 1,
      bytes: Number.isInteger(artifact.bytes) ? artifact.bytes : null,
      focusRect: artifact.focusRect && typeof artifact.focusRect === 'object' ? artifact.focusRect : null,
      stageLabels: Array.isArray(artifact.stageLabels)
        ? artifact.stageLabels.slice(0, 40).map((label) => String(label).slice(0, 100))
        : null,
      url: artifactUrl(slug, sessionId, artifact.id, { dense: !!sharp }),
    };
  }).concat(closeups);
}

// #2601/#2558: why a run that is still 'planned' never got under way, as
// the shots machine recorded it on the proposal (src/workflow/shots/).
// A sibling of `failureReason` rather than a reuse of it: a run that never
// started has not failed, and the two words reach different copy. It is
// dropped once the run has moved on, and on a superseded revision, where it
// would describe a schedule attempt nobody is looking at any more.
function notStartedReason(session, superseded) {
  const detail = session?.shots_detail;
  if (superseded || session?.shots_state !== 'planned') return null;
  const value = detail && typeof detail === 'object' ? detail.notStartedReason : null;
  return typeof value === 'string' && value.trim() ? value.slice(0, 300) : null;
}

function fromSnapshot(session, currentHead) {
  const detail = session?.shots_detail;
  if (!detail || typeof detail !== 'object') return null;
  const recordedHead = typeof detail.headSha === 'string' ? detail.headSha : null;
  const mismatched = !!(recordedHead && currentHead && recordedHead !== currentHead);
  return {
    state: mismatched ? 'stale' : (PUBLIC_STATES.has(session.shots_state)
      ? session.shots_state : 'planned'),
    required: detail.required !== false,
    impact: ['ui', 'motion', 'none'].includes(detail.impact) ? detail.impact : null,
    rationale: typeof detail.rationale === 'string' ? detail.rationale.slice(0, 1000) : null,
    claims: cleanClaims(detail.claims),
    baseSha: typeof detail.baseSha === 'string' ? detail.baseSha : null,
    headSha: recordedHead,
    failureCode: typeof detail.failureCode === 'string' ? state.currentCode(detail.failureCode) : null,
    failureReason: mismatched
      ? 'A newer revision of this proposal replaced these shots.'
      : (typeof detail.failureReason === 'string' ? detail.failureReason.slice(0, 2000) : null),
    notStartedReason: notStartedReason(session, mismatched),
    automaticRetryPending: false,
    repairAvailable: detail.repairAvailable === true,
    planHash: typeof detail.planHash === 'string' ? detail.planHash : null,
    shotResults: [],
    shotNotices: [],
    afterOnly: false,
    screens: [],
    progress: null,
    verifiedReason: null,
    overriddenBy: Number.isInteger(detail.overriddenBy) ? detail.overriddenBy : null,
    overriddenAt: detail.overriddenAt || null,
    overrideReason: typeof detail.overrideReason === 'string' ? detail.overrideReason.slice(0, 1000) : null,
    artifacts: [],
    updatedAt: session.shots_updated_at || detail.updatedAt || null,
  };
}

// Shots published on a head that a clean merge of main then moved stand for
// the merged head (the shots machine's carry): the slot names the merged
// head and the run they were taken on.
function carriedTo(session, run) {
  const detail = session?.shots_detail;
  if (!run || run.state !== 'verified' || !detail || typeof detail !== 'object') return null;
  return typeof detail.carriedFrom === 'string' && detail.carriedFrom === run.headSha
    && typeof detail.headSha === 'string' ? detail.headSha : null;
}

function matchesCurrentRun(run, currentHead, session = null) {
  return !currentHead || run.headSha === currentHead || carriedTo(session, run) === currentHead;
}

// The shots people last saw (shots_detail.previous): a run published on an
// earlier version of the proposal. Its card keeps them, labelled as the
// previous version's, while this version's are taken, and after they failed
// or were skipped, until this version's publish (src/workflow/shots/).
function previousRunId(session) {
  const value = session?.shots_detail?.previous;
  return value && typeof value === 'object' && ARTIFACT_ID_RE.test(String(value.runId || ''))
    ? String(value.runId) : null;
}

// The previous version's shots as a published run's view has them: what
// its card draws, and nothing about the run under way.
function serializePrevious(run, session, slug, { dense = false } = {}) {
  if (!run || run.id !== previousRunId(session) || run.sessionId !== Number(session?.id)) return null;
  const claims = cleanClaims(run.claims);
  const artifacts = cleanArtifacts(run.artifactSummary, { slug, sessionId: session.id, verified: true, dense });
  if (!claims.length || !artifacts.some((artifact) => artifact.variant === 'context')) return null;
  return {
    state: 'verified',
    claims,
    baseSha: run.baseSha || null,
    headSha: run.headSha || null,
    shotResults: cleanShotResults(run.shotResults),
    shotNotices: cleanShotNotices(run.shotNotices, claims),
    afterOnly: run.afterOnly === true,
    screens: withDensity(cleanScreens(run.screens, claims), artifacts),
    artifacts,
    updatedAt: run.updatedAt || null,
  };
}

// The view, with the previous version's shots beside it while this
// version has none published.
function withPrevious(view, previous) {
  if (!view) return view;
  return { ...view, previous: view.state !== 'verified' && view.state !== 'not_required' && previous ? previous : null };
}

// A screen's geometry stays its CSS pixels; its `density` is that of the
// still it shows (its first change's after screen shot), so a viewer shown
// 1x copies reads 1 and one shown dense stills reads theirs.
function withDensity(screens, artifacts) {
  return screens.map((screen) => {
    const still = artifacts.find((artifact) => artifact.storyId === screen.shot && artifact.viewport === screen.viewport
      && artifact.side === 'head' && artifact.variant === 'context' && artifact.theme === 'light');
    return { ...screen, density: still ? still.density : 1 };
  });
}

// `dense`: whether this viewer is shown stills at device density
// (viewerSeesDense). Off, the view is exactly what it was before them.
function serialize(run, session, slug, currentHead, { dense = false } = {}) {
  if (!run) return fromSnapshot(session, currentHead);
  const matchesCurrent = matchesCurrentRun(run, currentHead, session);
  const verified = matchesCurrent && run.state === 'verified';
  const artifacts = cleanArtifacts(run.artifactSummary, { slug, sessionId: session.id, verified, dense });
  const publicState = matchesCurrent ? run.state : 'stale';
  return {
    state: PUBLIC_STATES.has(publicState) ? publicState : 'failed',
    required: run.required !== false,
    impact: session?.shots_detail?.impact || null,
    rationale: session?.shots_detail?.rationale || null,
    claims: cleanClaims(run.claims),
    baseSha: run.baseSha || null,
    headSha: run.headSha || null,
    failureCode: matchesCurrent ? (run.failureCode || null) : 'superseded',
    failureReason: matchesCurrent
      ? (run.failureReason || null)
      : 'A newer revision of this proposal replaced these shots.',
    notStartedReason: notStartedReason(session, !matchesCurrent),
    // A restart or a platform fault ended this run and the recovery sweep
    // starts it again by itself, so the card says it is trying again instead
    // of asking a person to. A merged or archived proposal gets no automatic
    // retry.
    automaticRetryPending: matchesCurrent && run.automaticRetryPending === true
      && !['merged', 'archived'].includes(session?.status),
    repairAvailable: matchesCurrent && run.repairAvailable === true
      && !(run.automaticRetryPending === true && !['merged', 'archived'].includes(session?.status)),
    planHash: run.planHash || null,
    // A failed run carries them only when a declared change failed
    // (shots_change_failed), so the change page can say which one, or when
    // none could be reached (shots_capture_incomplete), so its author's
    // agent reads why each was skipped (get_proposal's nextStep).
    shotResults: matchesCurrent && (run.state === 'verified'
      || (run.state === 'failed' && ['shots_change_failed', 'shots_capture_incomplete'].includes(run.failureCode)))
      ? cleanShotResults(run.shotResults) : [],
    // Only a published run's card shows them.
    shotNotices: matchesCurrent && run.state === 'verified'
      ? cleanShotNotices(run.shotNotices, cleanClaims(run.claims)) : [],
    // A project's first version (services/shots-starter.js): its before was
    // the starter template's placeholder, so the run took the after side
    // only, and the card says "New app: nothing before".
    afterOnly: matchesCurrent && run.state === 'verified' && run.afterOnly === true,
    screens: verified ? withDensity(cleanScreens(run.screens, cleanClaims(run.claims)), artifacts) : [],
    progress: matchesCurrent && PUBLIC_STATES.has(run.state) ? (run.progress || null) : null,
    verifiedReason: null,
    overriddenBy: run.overriddenBy || null,
    overriddenAt: run.overriddenAt || null,
    overrideReason: run.overrideReason || null,
    artifacts,
    updatedAt: run.updatedAt || session.shots_updated_at || null,
  };
}

// Who is shown stills at device density: every signed-in viewer is, so the
// before/after pictures are the sharper copies. A guest, with no account, is
// shown the 1x copies.
async function viewerSeesDense(pool, viewer) {
  const id = Number(viewer?.id);
  return Number.isSafeInteger(id) && id > 0;
}

async function getForSession(pool, session, slug = session?.app_slug, { viewer = null } = {}) {
  if (!session || !session.id || !slug) return null;
  const currentHead = visualHeadForSession(session);
  let run = null;
  if (currentHead) run = await state.getForSession(pool, Number(session.id), { headSha: currentHead });
  // Shots carried across a clean merge of main were taken on the head it
  // left.
  const carriedFrom = session.shots_detail?.carriedFrom;
  if (!run && currentHead && session.shots_detail?.headSha === currentHead && state.validSha(carriedFrom)) {
    run = await state.getForSession(pool, Number(session.id), { headSha: carriedFrom });
  }
  const previousId = previousRunId(session);
  const dense = run || previousId ? await viewerSeesDense(pool, viewer) : false;
  const view = serialize(run, session, slug, currentHead, { dense });
  if (!view || !previousId || view.state === 'verified' || view.state === 'not_required') return withPrevious(view, null);
  const previous = (await state.getPublishedRuns(pool, [previousId])).get(previousId);
  return withPrevious(view, serializePrevious(previous, session, slug, { dense }));
}

async function getForSessions(pool, sessions, slug, { viewer = null } = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const runIds = list.map((session) => session.shots_run_id).filter(Boolean);
  const bySession = new Map();
  if (runIds.length) {
    const { rows } = await pool.query(
      `SELECT r.*,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', a.id, 'storyId', a.story_id, 'viewport', a.viewport,
                  'side', a.side, 'variant', a.variant, 'media', a.media,
                  'theme', a.theme,
                  'contentType', a.content_type, 'width', a.width,
                  'height', a.height, 'bytes', a.bytes,
                  'density', a.density, 'denseWidth', a.dense_width, 'denseHeight', a.dense_height,
                  'focusRect', a.focus_rect, 'stageLabels', a.stage_labels,
                  'part', a.part, 'scale', a.scale
                ) ORDER BY a.story_id, a.viewport, a.side, a.variant, a.theme, a.part)
                  FROM shot_artifacts a WHERE a.run_id = r.id
              ), '[]'::jsonb) AS artifact_summary
         FROM shot_runs r WHERE r.id = ANY($1::varchar[])`,
      [runIds]
    );
    for (const row of rows) bySession.set(Number(row.session_id), state.runSummary(row, row.artifact_summary || []));
  }
  // The previous version's shots, for the proposals whose own are not
  // published (shots_detail.previous).
  const previousIds = list.filter((session) => session.shots_state !== 'verified' && session.shots_state !== 'not_required')
    .map(previousRunId).filter(Boolean);
  const previousRuns = previousIds.length ? await state.getPublishedRuns(pool, previousIds) : new Map();
  const dense = bySession.size || previousRuns.size ? await viewerSeesDense(pool, viewer) : false;
  const result = new Map();
  for (const session of list) {
    const currentHead = visualHeadForSession(session);
    const view = serialize(
      bySession.get(Number(session.id)) || null,
      session,
      slug || session.app_slug,
      currentHead,
      { dense },
    );
    const previousId = previousRunId(session);
    result.set(Number(session.id), withPrevious(view, previousId
      ? serializePrevious(previousRuns.get(previousId), session, slug || session.app_slug, { dense }) : null));
  }
  return result;
}

module.exports = {
  PUBLIC_STATES,
  cleanClaims,
  cleanShotResults,
  cleanShotNotices,
  cleanScreens,
  cleanArtifacts,
  artifactUrl,
  viewerSeesDense,
  notStartedReason,
  fromSnapshot,
  serialize,
  serializePrevious,
  withPrevious,
  getForSession,
  getForSessions,
};
