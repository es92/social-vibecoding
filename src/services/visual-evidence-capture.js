'use strict';

// Capture-first visual evidence. The hosted evidence agent follows the
// author's accepted steps on the exact base and head previews and hands the
// platform the screenshots it took itself, one base/head pair per claim and
// viewport. Nothing is replayed: the images are the agent's own observations
// on platform-built, fixture-seeded revisions, and people still judge them.
//
// This module is pure. It validates one submitted image against the accepted
// intent and folds the submissions into per-claim results, so a claim the
// agent could not reach no longer discards the claims it did capture.

const crypto = require('crypto');
const planContract = require('./visual-evidence-plan');

const CAPTURE_MODE = 'agent_capture';
const CAPTURE_VARIANTS = Object.freeze(['context', 'focus']);
const MAX_CAPTURE_BYTES = 6 * 1024 * 1024;
const MAX_CAPTURE_EDGE = 8192;
const MAX_BLOCKER_REASON = 1000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

class EvidenceCaptureError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'EvidenceCaptureError';
    this.code = code;
    this.status = status;
  }
}

// Structural PNG check without decoding pixels: the platform image ships
// without an image codec, and the header plus terminator is enough to refuse
// anything that is not one complete PNG of a sane size.
function inspectPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length + 25 + PNG_IEND.length) {
    throw new EvidenceCaptureError('invalid_capture_image', 'The capture must be a complete PNG image.');
  }
  if (buffer.length > MAX_CAPTURE_BYTES) {
    throw new EvidenceCaptureError('capture_too_large',
      `A capture may be at most ${MAX_CAPTURE_BYTES} bytes; take a viewport or element screenshot instead of a full page.`, 413);
  }
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)
      || buffer.readUInt32BE(8) !== 13
      || buffer.toString('latin1', 12, 16) !== 'IHDR'
      || !buffer.subarray(buffer.length - PNG_IEND.length).equals(PNG_IEND)) {
    throw new EvidenceCaptureError('invalid_capture_image', 'The capture must be a complete PNG image.');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_CAPTURE_EDGE || height > MAX_CAPTURE_EDGE) {
    throw new EvidenceCaptureError('invalid_capture_image', 'The capture has unsupported dimensions.');
  }
  return {
    width,
    height,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

function storyFor(intent, storyId) {
  const story = intent.stories.find((candidate) => candidate.id === storyId);
  if (!story) {
    throw new EvidenceCaptureError('unknown_capture_story', `Story ${JSON.stringify(String(storyId))} is not in the accepted intent.`);
  }
  return story;
}

function captureKey({ storyId, viewport, side, variant }) {
  return `${storyId}\u0000${viewport}\u0000${side}\u0000${variant}`;
}

// Validates a submission's addressing against the frozen intent and returns
// the normalized key fields. The image itself is checked by inspectPng.
function captureTarget(intent, raw = {}) {
  const storyId = String(raw.storyId || '');
  const story = storyFor(intent, storyId);
  const viewport = String(raw.viewport || '');
  if (!story.viewports.some((candidate) => candidate.name === viewport)) {
    throw new EvidenceCaptureError('unknown_capture_viewport',
      `Viewport ${JSON.stringify(viewport)} is not accepted for story ${storyId}; use one of ${story.viewports.map((v) => v.name).join(', ')}.`);
  }
  const side = String(raw.side || '');
  if (!['base', 'head'].includes(side)) {
    throw new EvidenceCaptureError('invalid_capture_side', 'Side must be base or head.');
  }
  const variant = String(raw.variant || 'context');
  if (!CAPTURE_VARIANTS.includes(variant)) {
    throw new EvidenceCaptureError('invalid_capture_variant', 'Variant must be context (the viewport) or focus (the claimed element).');
  }
  return { storyId, viewport, side, variant };
}

function blockerReason(value) {
  const reason = typeof value === 'string' ? value.trim().slice(0, MAX_BLOCKER_REASON) : '';
  if (!reason) throw new EvidenceCaptureError('evidence_reason_required', 'A concise user-visible reason is required.');
  return reason;
}

// Folds the submitted images into one result per accepted claim. A claim is
// captured when every accepted viewport has a base and a head context image;
// focus crops are optional extras. Anything short of that is reported with
// what is missing, or with the agent's stated blocker, never silently.
function summarize(intent, captures, blockers = new Map()) {
  const artifacts = [];
  const stories = intent.stories.map((story) => {
    const missing = [];
    const storyArtifacts = [];
    for (const viewport of story.viewports) {
      for (const side of ['base', 'head']) {
        for (const variant of CAPTURE_VARIANTS) {
          const capture = captures.get(captureKey({ storyId: story.id, viewport: viewport.name, side, variant }));
          if (capture) storyArtifacts.push(capture);
          else if (variant === 'context') missing.push(`${viewport.name} ${side}`);
        }
      }
    }
    const blocker = blockers.get(story.id) || null;
    if (!missing.length) {
      artifacts.push(...storyArtifacts);
      return { id: story.id, status: 'captured', captures: storyArtifacts.length };
    }
    return {
      id: story.id,
      status: 'blocked',
      reason: blocker
        || `The preview agent did not capture ${missing.join(', ')}.`,
    };
  });
  const captured = stories.filter((story) => story.status === 'captured');
  const manifest = artifacts
    .map(({ storyId, viewport, side, variant, sha256 }) => ({ storyId, viewport, side, variant, sha256 }))
    .sort((a, b) => captureKey(a).localeCompare(captureKey(b)));
  return {
    stories,
    artifacts,
    capturedCount: captured.length,
    // Stored in plan_hash: it fences artifact storage exactly as a replay
    // plan hash does, and identifies precisely which images were published.
    manifestHash: crypto.createHash('sha256')
      .update(planContract.canonicalJson({ mode: CAPTURE_MODE, intent, manifest }))
      .digest('hex'),
    hardVerdict: {
      passed: captured.length > 0,
      mode: CAPTURE_MODE,
      runs: 1,
      stories,
    },
  };
}

function artifactFor(target, buffer, info) {
  return {
    ...target,
    media: 'png',
    contentType: 'image/png',
    data: buffer,
    width: info.width,
    height: info.height,
    bytes: info.bytes,
    sha256: info.sha256,
    focusRect: null,
    stageLabels: null,
  };
}

function isCaptureVerdict(hardVerdict) {
  return !!hardVerdict && typeof hardVerdict === 'object' && hardVerdict.mode === CAPTURE_MODE;
}

module.exports = {
  CAPTURE_MODE,
  CAPTURE_VARIANTS,
  MAX_CAPTURE_BYTES,
  EvidenceCaptureError,
  inspectPng,
  captureKey,
  captureTarget,
  blockerReason,
  summarize,
  artifactFor,
  isCaptureVerdict,
};
