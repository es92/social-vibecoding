'use strict';

// An evidence turn gets one purpose-bound JWT and this in-memory run-scoped
// control plane. It cannot address another run, obtain app auth material, or
// invoke generic platform APIs. A platform restart invalidates the registry;
// recovery terminalizes or retries the durable run rather than trusting an
// orphan model process.

const planContract = require('./visual-evidence-plan');
const capture = require('./visual-evidence-capture');

const controls = new Map();
const FINISH_STATUSES = new Set(['verified', 'not_relevant', 'failed']);
const MAX_REPAIR_ATTEMPTS = 2;

class EvidenceControlError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'EvidenceControlError';
    this.code = code;
    this.status = status;
  }
}

function boundedReason(value) {
  const reason = typeof value === 'string' ? value.trim().slice(0, 1000) : '';
  if (!reason) throw new EvidenceControlError('evidence_reason_required', 'A concise user-visible reason is required.', 400);
  return reason;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function preservesTimingRepair(rejected, corrected, failure) {
  if (!rejected || rejected.stories.length !== corrected.stories.length) return false;
  const unchangedFlow = rejected.stories.every((story, index) => {
    const next = corrected.stories[index];
    if (story.id !== next.id || planContract.canonicalJson(story.replay.checkpoint)
        !== planContract.canonicalJson(next.replay.checkpoint)) return false;
    return ['before', 'after'].every((side) => story.replay[side].startPath === next.replay[side].startPath
      && planContract.canonicalJson(story.replay[side].actions.filter((action) => action.type !== 'waitFor'))
        === planContract.canonicalJson(next.replay[side].actions.filter((action) => action.type !== 'waitFor')));
  });
  if (!unchangedFlow) return false;

  // The wait must observe the exact marker that failed and occur after the
  // final interaction. Waiting on an unrelated control only burns time and
  // can make a broken motion flow appear to have settled.
  const detail = failure?.detail;
  const side = detail?.side === 'base' ? 'before' : detail?.side === 'head' ? 'after' : null;
  const oldStory = rejected.stories.find((story) => story.id === detail?.storyId);
  const newStory = corrected.stories.find((story) => story.id === detail?.storyId);
  const failedAssertion = side && Number.isInteger(detail?.assertionIndex)
    ? oldStory?.replay?.checkpoint?.assertions?.[side]?.[detail.assertionIndex] : null;
  if (!failedAssertion?.target || !newStory) return false;
  const actions = newStory.replay[side].actions;
  const finalInteraction = actions.findLastIndex((action) => action.type !== 'waitFor');
  return actions.slice(finalInteraction + 1).some((action) => action.type === 'waitFor'
    && action.state === 'hidden'
    && action.target
    && planContract.canonicalJson(action.target) === planContract.canonicalJson(failedAssertion.target));
}

function preservesAssertionLocatorRepair(rejected, corrected, failure) {
  const detail = failure?.detail;
  const side = detail?.side === 'base' ? 'before' : detail?.side === 'head' ? 'after' : null;
  if (!rejected || !side || !Number.isInteger(detail?.assertionIndex)) return false;
  const oldStory = rejected.stories.find((story) => story.id === detail.storyId);
  const newStory = corrected.stories.find((story) => story.id === detail.storyId);
  const oldAssertion = oldStory?.replay?.checkpoint?.assertions?.[side]?.[detail.assertionIndex];
  const newAssertion = newStory?.replay?.checkpoint?.assertions?.[side]?.[detail.assertionIndex];
  if (!oldAssertion?.target || !newAssertion?.target
      || planContract.canonicalJson(oldAssertion) !== planContract.canonicalJson(detail.assertion)
      || planContract.canonicalJson(oldAssertion.target)
        === planContract.canonicalJson(newAssertion.target)) return false;

  // A failed positive assertion may have pointed at the wrong element, but
  // that does not authorize the repair turn to rewrite what the checkpoint
  // proves. Put the old target back into a copy of the proposed correction;
  // the entire plan must then be byte-for-byte equivalent to the rejected
  // plan. This pins the assertion type and expected count/value as well as
  // every action, route, focus target, sibling assertion, and other story.
  const normalized = cloneJson(corrected);
  const normalizedStory = normalized.stories.find((story) => story.id === detail.storyId);
  normalizedStory.replay.checkpoint.assertions[side][detail.assertionIndex].target
    = cloneJson(oldAssertion.target);
  return planContract.canonicalJson(normalized) === planContract.canonicalJson(rejected);
}

class RunControl {
  constructor({ runId, sessionId, intent, context, resetPair, runPlan, expiresAt, mode = 'replay' }) {
    this.runId = runId;
    this.sessionId = Number(sessionId);
    this.intent = planContract.parseIntent(intent);
    this.context = cloneJson(context);
    // 'capture' runs publish the agent's own screenshots; 'replay' runs
    // publish only what two platform replays of a submitted plan produced.
    this.mode = mode === 'capture' ? 'capture' : 'replay';
    this.captures = new Map();
    this.storyBlockers = new Map();
    this.resetPairCallback = resetPair;
    // During a rolling deploy an older evidence worker may still call the
    // retired one-side endpoint twice, once for base and once for head. Keep
    // the first atomic pair available for the companion call so that the
    // second request cannot invalidate the origin returned by the first.
    this.legacyResetPair = null;
    this.legacyResetSides = new Set();
    this.runPlanCallback = runPlan;
    this.expiresAt = Number(expiresAt || Date.now() + 8 * 60_000);
    this.planCalls = 0;
    this.maxPlanCalls = 1;
    this.latestHard = null;
    // Tool errors also need to survive a successful model process exit. A
    // rejected plan never reaches the replay callback, but is just as useful
    // when diagnosing a turn that submitted no passing replay.
    this.lastToolFailure = null;
    // A model may call run-plan again after a failed replay. The second call
    // only reports the attempt limit; it must not replace the browser failure
    // from the replay that actually ran.
    this.lastReplayFailure = null;
    this.finished = null;
    this.repairReason = null;
    this.repairFailure = null;
    this.rejectedPlan = null;
    this.lastSubmittedPlan = null;
    this.planTask = null;
    this.waiters = new Set();
    this.busy = null;
  }

  assertLive() {
    if (Date.now() > this.expiresAt) {
      throw new EvidenceControlError('evidence_control_expired', 'This evidence turn has expired.', 410);
    }
  }

  getContext() {
    this.assertLive();
    return cloneJson({
      ...this.context,
      mode: this.mode,
      ...(this.mode === 'capture' ? { captureStatus: this.captureStatus() } : {}),
      attempt: this.planCalls + 1,
      repairReason: this.repairReason,
      ...(this.repairFailure ? {
        repair: { failure: this.repairFailure, rejectedPlan: this.rejectedPlan },
      } : {}),
    });
  }

  async resetPair() {
    try {
      this.assertLive();
      if (this.finished) throw new EvidenceControlError('evidence_turn_finished', 'This evidence turn is already finished.');
      if (typeof this.resetPairCallback !== 'function') {
        throw new EvidenceControlError('evidence_reset_unavailable', 'Paired reset is unavailable for this run.', 503);
      }
      if (this.busy) throw new EvidenceControlError('evidence_control_busy', `Evidence is already ${this.busy}.`, 409);
      this.busy = 'resetting paired state';
      try {
        const result = await this.resetPairCallback();
        if (!result?.origins?.base || !result?.origins?.head) {
          throw new EvidenceControlError(
            'invalid_evidence_reset', 'Paired reset did not return both replacement origins.', 500
          );
        }
        this.legacyResetPair = null;
        this.legacyResetSides.clear();
        return cloneJson(result);
      }
      finally { this.busy = null; }
    } catch (error) {
      if (this.lastToolFailure?.operation !== 'run-plan') {
        this.lastToolFailure = { operation: 'reset-pair', error };
      }
      throw error;
    }
  }

  async resetSide(side) {
    if (!['base', 'head'].includes(side)) {
      throw new EvidenceControlError('invalid_evidence_side', 'Side must be base or head.', 400);
    }
    this.assertLive();
    if (this.finished) throw new EvidenceControlError('evidence_turn_finished', 'This evidence turn is already finished.');
    if (this.busy) throw new EvidenceControlError('evidence_control_busy', `Evidence is already ${this.busy}.`, 409);
    let pair = this.legacyResetPair;
    if (!pair || this.legacyResetSides.has(side)) {
      pair = await this.resetPair();
      this.legacyResetPair = pair;
      this.legacyResetSides.clear();
    }
    this.legacyResetSides.add(side);
    return {
      side,
      origin: pair.origins[side],
      origins: cloneJson(pair.origins),
      bothSidesReset: true,
    };
  }

  queuePlan(rawPlan) {
    let plan;
    try {
      this.assertLive();
      if (this.finished) throw new EvidenceControlError('evidence_turn_finished', 'This evidence turn is already finished.');
      if (this.planCalls >= this.maxPlanCalls) {
        throw new EvidenceControlError('evidence_plan_attempt_exhausted', 'No additional replay-plan attempt is available.');
      }
      if (this.busy) throw new EvidenceControlError('evidence_control_busy', `Evidence is already ${this.busy}.`, 409);
      plan = planContract.parseReplayPlan(rawPlan);
      const projected = planContract.semanticIntentFromPlan(plan);
      if (planContract.canonicalJson(projected) !== planContract.canonicalJson(this.intent)) {
        throw new EvidenceControlError(
          'evidence_intent_mismatch',
          'The executable plan must preserve the accepted claims, personas, viewports, flow summary, focus, and animation intent.',
          400
        );
      }
      if (this.planCalls > 0 && this.planCalls === this.maxPlanCalls - 1
          && planContract.planHash(plan) === planContract.planHash(this.rejectedPlan)) {
        throw new EvidenceControlError(
          'evidence_repair_unchanged',
          'The corrected replay plan must differ from the rejected plan.',
          400
        );
      }
      if (this.repairFailure?.kind === 'motion_timing'
          && !preservesTimingRepair(this.rejectedPlan, plan, this.repairFailure)) {
        throw new EvidenceControlError(
          'evidence_timing_repair_changed_flow',
          'A motion timing correction may change waits only. Keep the original interactions, routes, and assertions, then wait for the failed marker to become hidden before the checkpoint.',
          400
        );
      }
      if (this.repairFailure?.kind === 'assertion_locator'
          && !preservesAssertionLocatorRepair(this.rejectedPlan, plan, this.repairFailure)) {
        throw new EvidenceControlError(
          'evidence_assertion_locator_repair_changed_plan',
          'An assertion locator correction may change only the failed assertion target. Keep its type and expected value or count, plus every action, route, focus target, and other assertion unchanged.',
          400
        );
      }
    } catch (error) {
      this.lastToolFailure = { operation: 'run-plan', error };
      throw error;
    }
    // Reserve before starting the asynchronous replay. The MCP request can
    // acknowledge this immutable plan without holding an HTTP connection
    // open through every browser case and both passes.
    this.lastSubmittedPlan = cloneJson(plan);
    const attempt = ++this.planCalls;
    const planHash = planContract.planHash(plan);
    this.busy = 'replaying the submitted plan';
    const replayStartedAt = Date.now();
    const completion = Promise.resolve().then(() => this.runPlanCallback(plan, { attempt }))
      .then((result) => {
        this.lastToolFailure = null;
        this.lastReplayFailure = null;
        this.latestHard = result?.hardVerdict?.passed === true
          ? { passed: true, planHash: result.planHash, attempt }
          : null;
        return result;
      }, (error) => {
        // A corrected replay may supersede an earlier failure. Keep the
        // browser error even if the model submits a duplicate afterward.
        this.lastReplayFailure = { operation: 'run-plan', error };
        this.lastToolFailure = { operation: 'run-plan', error };
        throw error;
      }).finally(() => {
        // Each deterministic replay pass has its own container deadline. Do
        // not expire the run's control window while that bounded platform
        // work is running; a locator failure may need a new correction turn.
        this.expiresAt += Date.now() - replayStartedAt;
        this.busy = null;
      });
    // The hosted agent may exit after receiving the acknowledgement. The
    // orchestrator still awaits this promise; attach a handler immediately so
    // a replay that fails first cannot become an unhandled rejection.
    completion.catch(() => {});
    this.planTask = completion;
    return { attempt, planHash, completion };
  }

  async runPlan(rawPlan) {
    return this.queuePlan(rawPlan).completion;
  }

  submitPlan(rawPlan) {
    try {
      this.assertLive();
      const candidate = planContract.parseReplayPlan(rawPlan);
      const planHash = planContract.planHash(candidate);
      if (!this.finished && this.planCalls === this.maxPlanCalls && this.lastSubmittedPlan
          && planHash === planContract.planHash(this.lastSubmittedPlan)) {
        return { accepted: true, attempt: this.planCalls, planHash, duplicate: true };
      }
      const queued = this.queuePlan(candidate);
      return { accepted: true, attempt: queued.attempt, planHash: queued.planHash, duplicate: false };
    } catch (error) {
      this.lastToolFailure = { operation: 'run-plan', error };
      throw error;
    }
  }

  submitReplays(rawReplays) {
    try { return this.submitPlan(planContract.replayPlanFromIntent(this.intent, rawReplays)); }
    catch (error) {
      this.lastToolFailure = { operation: 'run-plan', error };
      throw error;
    }
  }

  waitForPlan() {
    return this.planTask || Promise.resolve(null);
  }

  async runReplays(rawReplays) {
    try {
      return await this.runPlan(planContract.replayPlanFromIntent(this.intent, rawReplays));
    } catch (error) {
      this.lastToolFailure = { operation: 'run-plan', error };
      throw error;
    }
  }

  finish({ status, reason, planHash = null }) {
    this.assertLive();
    if (this.busy) throw new EvidenceControlError('evidence_control_busy', `Evidence is already ${this.busy}.`, 409);
    if (!FINISH_STATUSES.has(status)) {
      throw new EvidenceControlError('invalid_evidence_finish', 'Status must be verified, not_relevant, or failed.', 400);
    }
    if (this.finished) throw new EvidenceControlError('evidence_turn_finished', 'This evidence turn is already finished.');
    const visibleReason = boundedReason(reason);
    if (status === 'verified') {
      if (!this.latestHard?.passed || !planHash || planHash !== this.latestHard.planHash) {
        throw new EvidenceControlError(
          'evidence_hard_verdict_required',
          'Verified may only finish the most recent passing replay plan.',
          400
        );
      }
    }
    this.finished = { status, reason: visibleReason, planHash: planHash || null, at: new Date().toISOString() };
    for (const resolve of this.waiters) resolve(cloneJson(this.finished));
    this.waiters.clear();
    return cloneJson(this.finished);
  }

  assertCaptureMode() {
    this.assertLive();
    if (this.mode !== 'capture') {
      throw new EvidenceControlError('evidence_capture_unavailable', 'This evidence run replays a submitted plan; it does not accept screenshots.');
    }
    if (this.finished) throw new EvidenceControlError('evidence_turn_finished', 'This evidence turn is already finished.');
  }

  // One screenshot the agent took on the base or head preview, addressed to
  // an accepted claim and viewport. A later submission for the same slot
  // replaces the earlier one, so the agent can retake a poor shot.
  submitCapture(rawTarget, buffer) {
    try {
      this.assertCaptureMode();
      const target = capture.captureTarget(this.intent, rawTarget);
      const info = capture.inspectPng(buffer);
      this.captures.set(capture.captureKey(target), capture.artifactFor(target, buffer, info));
      return {
        accepted: true,
        ...target,
        width: info.width,
        height: info.height,
        bytes: info.bytes,
        ...this.captureStatus(),
      };
    } catch (error) {
      this.lastToolFailure = { operation: 'capture', error };
      throw error;
    }
  }

  // The agent could not reach one claim's state. The reason is shown on the
  // proposal for that claim; the claims it did capture are still published.
  blockStory({ storyId, reason } = {}) {
    try {
      this.assertCaptureMode();
      const story = this.intent.stories.find((candidate) => candidate.id === String(storyId || ''));
      if (!story) {
        throw new EvidenceControlError('unknown_capture_story', `Story ${JSON.stringify(String(storyId || ''))} is not in the accepted intent.`, 400);
      }
      this.storyBlockers.set(story.id, capture.blockerReason(reason));
      return { accepted: true, storyId: story.id, ...this.captureStatus() };
    } catch (error) {
      this.lastToolFailure = { operation: 'block-story', error };
      throw error;
    }
  }

  captureSummary() {
    // A whole-run blocker explains every claim that has no reason of its own.
    const blockers = new Map(this.storyBlockers);
    if (this.finished?.status === 'failed') {
      for (const story of this.intent.stories) {
        if (!blockers.has(story.id)) blockers.set(story.id, this.finished.reason);
      }
    }
    return capture.summarize(this.intent, this.captures, blockers);
  }

  captureStatus() {
    const summary = capture.summarize(this.intent, this.captures, this.storyBlockers);
    return {
      stories: summary.stories.map((story) => ({
        id: story.id,
        status: story.status === 'captured' ? 'captured'
          : this.storyBlockers.has(story.id) ? 'blocked' : 'missing',
        ...(story.status === 'captured' ? {} : { detail: story.reason }),
      })),
    };
  }

  allowRepair(reason, failure) {
    if (this.busy) throw new EvidenceControlError('evidence_control_busy', `Evidence is already ${this.busy}.`, 409);
    if (this.planCalls !== this.maxPlanCalls || this.planCalls > MAX_REPAIR_ATTEMPTS
        || !this.lastReplayFailure || !this.lastSubmittedPlan) {
      throw new EvidenceControlError('evidence_repair_unavailable', 'No additional repair attempt is available.');
    }
    this.maxPlanCalls += 1;
    this.repairReason = boundedReason(reason);
    this.repairFailure = cloneJson(failure);
    this.rejectedPlan = cloneJson(this.lastSubmittedPlan);
    this.finished = null;
    this.latestHard = null;
  }

  waitForFinish({ signal = null, timeoutMs = 480_000 } = {}) {
    if (this.finished) return Promise.resolve(cloneJson(this.finished));
    return new Promise((resolve, reject) => {
      let timer = null;
      const done = (value) => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', aborted);
        this.waiters.delete(done);
        resolve(value);
      };
      const aborted = () => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(done);
        reject(new EvidenceControlError('evidence_agent_cancelled', 'The evidence agent turn was cancelled.', 499));
      };
      this.waiters.add(done);
      timer = setTimeout(() => {
        this.waiters.delete(done);
        reject(new EvidenceControlError('evidence_agent_timeout', 'The evidence agent did not finish within its time budget.', 408));
      }, timeoutMs);
      timer.unref?.();
      if (signal) {
        if (signal.aborted) aborted();
        else signal.addEventListener('abort', aborted, { once: true });
      }
    });
  }
}

function registerRun(options) {
  if (!/^[0-9a-f]{32}$/.test(String(options?.runId || ''))) {
    throw new EvidenceControlError('invalid_evidence_run', 'A valid evidence run id is required.', 400);
  }
  if (controls.has(options.runId)) throw new EvidenceControlError('evidence_control_exists', 'This evidence run is already registered.');
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
  if (!control) throw new EvidenceControlError('evidence_control_not_found', 'This evidence run is no longer active.', 410);
  if (control.sessionId !== Number(sessionId)) {
    throw new EvidenceControlError('evidence_scope_mismatch', 'Evidence token does not own this run.', 403);
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
