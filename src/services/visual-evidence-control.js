'use strict';

// A before/after run gets one purpose-bound JWT and this in-memory,
// run-scoped control plane. The preview agent can read its brief, save shots
// and clips, and skip a change with a reason. It cannot address another
// run, obtain app auth material, or invoke generic platform APIs. A platform
// restart drops the registry; recovery retries the durable run rather than
// trusting an orphan model process.

const planContract = require('./visual-evidence-plan');
const shots = require('./visual-evidence-shots');

const controls = new Map();

class EvidenceControlError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'EvidenceControlError';
    this.code = code;
    this.status = status;
  }
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class RunControl {
  constructor({ runId, sessionId, intent, context, expiresAt }) {
    this.runId = runId;
    this.sessionId = Number(sessionId);
    this.intent = planContract.parseIntent(intent);
    this.context = cloneJson(context);
    this.expiresAt = Number(expiresAt || Date.now() + 8 * 60_000);
    this.saved = new Map();
    this.skipped = new Map();
    // Set when the agent says nothing at all can be shot (for example every
    // screen shows a sign-in page); it explains every change without its own.
    this.skippedAll = null;
    // The last refused tool call survives a normal model exit, for the
    // owner's diagnostics.
    this.lastToolFailure = null;
  }

  assertLive() {
    if (Date.now() > this.expiresAt) {
      throw new EvidenceControlError('evidence_control_expired', 'This preview run has expired.', 410);
    }
  }

  assertOpen() {
    this.assertLive();
    if (this.skippedAll) throw new EvidenceControlError('evidence_turn_finished', 'This preview run was already skipped.');
  }

  getContext() {
    this.assertLive();
    return cloneJson({ ...this.context, progress: this.progress() });
  }

  // One file the agent saved: a screen or element shot, or a clip. Saving the
  // same slot again replaces it, so the agent can retake a poor shot.
  saveShot(rawTarget, buffer) {
    try {
      this.assertOpen();
      const target = shots.shotTarget(this.intent, rawTarget);
      const info = target.media === 'webm' ? shots.inspectClip(buffer) : shots.inspectImage(buffer);
      this.saved.set(shots.slotKey(target), shots.stored(target, buffer, info));
      return {
        saved: true,
        change: target.storyId,
        screen: target.viewport,
        side: target.side === 'base' ? 'before' : 'after',
        kind: target.variant === 'animation' ? 'clip' : target.variant === 'focus' ? 'element' : 'screen',
        bytes: info.bytes,
        ...(info.width ? { width: info.width, height: info.height } : {}),
        progress: this.progress(),
      };
    } catch (error) {
      this.lastToolFailure = { operation: 'save-shot', error };
      throw error;
    }
  }

  // The agent could not reach a change. Its reason is shown on the proposal
  // for that change; the changes it did shoot are still published. Without
  // a change id the reason covers every change that has none of its own.
  skipChange({ change = null, reason } = {}) {
    try {
      this.assertOpen();
      const text = shots.reason(reason);
      if (change == null || change === '') {
        this.skippedAll = text;
        return { skipped: 'all', progress: this.progress() };
      }
      const story = this.intent.stories.find((candidate) => candidate.id === String(change));
      if (!story) {
        throw new EvidenceControlError('unknown_change', `Change ${JSON.stringify(String(change))} is not one the author declared.`, 400);
      }
      this.skipped.set(story.id, text);
      return { skipped: story.id, progress: this.progress() };
    } catch (error) {
      this.lastToolFailure = { operation: 'skip-change', error };
      throw error;
    }
  }

  summary() {
    const reasons = new Map(this.skipped);
    if (this.skippedAll) {
      for (const story of this.intent.stories) {
        if (!reasons.has(story.id)) reasons.set(story.id, this.skippedAll);
      }
    }
    return shots.summarize(this.intent, this.saved, reasons);
  }

  progress() {
    return this.summary().stories.map((story) => ({
      change: story.id,
      status: story.status === 'ready' ? 'ready'
        : this.skipped.has(story.id) || this.skippedAll ? 'skipped' : 'missing',
      ...(story.status === 'ready' ? {} : { detail: story.reason }),
    }));
  }
}

function registerRun(options) {
  if (!/^[0-9a-f]{32}$/.test(String(options?.runId || ''))) {
    throw new EvidenceControlError('invalid_evidence_run', 'A valid preview run id is required.', 400);
  }
  if (controls.has(options.runId)) throw new EvidenceControlError('evidence_control_exists', 'This preview run is already registered.');
  const control = new RunControl(options);
  controls.set(options.runId, control);
  return {
    control,
    unregister() {
      if (controls.get(options.runId) === control) controls.delete(options.runId);
    },
  };
}

function forRequest({ runId, sessionId }) {
  const control = controls.get(String(runId || ''));
  if (!control) throw new EvidenceControlError('evidence_control_not_found', 'This preview run is no longer active.', 410);
  if (control.sessionId !== Number(sessionId)) {
    throw new EvidenceControlError('evidence_scope_mismatch', 'This token does not own this preview run.', 403);
  }
  control.assertLive();
  return control;
}

function clearForTests() {
  controls.clear();
}

module.exports = {
  EvidenceControlError,
  RunControl,
  registerRun,
  forRequest,
  _clearForTests: clearForTests,
};
