'use strict';

// Which half of a checks run a proposal gets right now.
//
// A checks run has two halves that used to be inseparable: the PREVIEW — a
// staging build, screenshots, the before/after media the card shows — and
// the VERDICT — the dapp.json assertions against that preview plus the
// repo's own unit suite, ~5 minutes of capture and container time that end
// in check_state. The preview is for the people reviewing the change; the
// verdict is for the merge gate.
//
// Under direct-merge lanes (services/merge-queue.js) a proposal merges as it
// stands the moment it is approved and merges cleanly with main. A proposal
// that CONFLICTS with main cannot merge as it stands: the tree the group
// would test today is not the tree that lands after the resolution, so a
// verdict about it is a verdict about nothing — and it was the platform's
// most expensive one, spent on every promoted head whether or not it could
// ever merge. So a promoted head that conflicts gets the preview and no
// verdict: check_state stays 'pending' with check_phase 'deferred', and the
// verdict runs once the head measures clean (services/integration.js fires
// onBecameClean; the conflict lane's resolution pushes a new head that gets
// its own run).
//
// Two things keep this from being a way to skip the checks:
//
//   - it applies to PROMOTED rows only. A draft's checks run in the author's
//     loop as feedback on their own work, and a CLI handoff's pre-vote run is
//     how its author learns the change works — neither is the merge gate.
//   - a human pressing "Re-run checks" gets the run they asked for. The
//     result is informational until the head merges cleanly (the integration
//     gate refuses a measured conflict before the checks gate is reached),
//     but an author debugging a failing assertion should not have to resolve
//     a conflict first to see the assertion.
//
// Never throws, and fails OPEN to the full run: a measurement that cannot be
// taken costs compute, a wrong deferral costs a verdict.

const log = require('./logger');
const integration = require('./integration');

const MANUAL_TRIGGERS = new Set(['manual-recheck']);

/**
 * @returns {{ mode: 'full'|'shots_only', reason: string, measured?: object }}
 *   `mode` is what captureForSession should run; `reason` says why, in the
 *   vocabulary the log line and the card share.
 */
async function decide({ pool, session, app = null, commitHash = null, trigger = null }) {
  const s = session || {};
  if (s.status !== 'promoted') return { mode: 'full', reason: 'not_promoted' };
  if (MANUAL_TRIGGERS.has(trigger)) return { mode: 'full', reason: 'manual' };
  if (!pool) return { mode: 'full', reason: 'no_pool' };

  // measure() reads the repo off the session row; the capture path often
  // holds it on the app descriptor instead.
  const row = { ...s, repo_url: s.repo_url || (app && app.repo_url) || null };
  let measured;
  try {
    measured = await integration.measureDeduped({ pool, session: row }, { force: true });
  } catch (err) {
    log.warn('check-admission', 'measurement threw; running the full suite', {
      sessionId: s.id, err: err && err.message,
    });
    return { mode: 'full', reason: 'measure_threw' };
  }
  if (!measured || measured.error || measured.skipped) {
    return { mode: 'full', reason: measured && (measured.error ? 'measure_error' : measured.skipped) || 'unmeasured', measured };
  }
  // The answer has to be about the commit this run is going to capture. A
  // measurement of another head — the branch moved between the build and
  // the capture — says nothing about this one.
  if (commitHash && measured.headSha
      && String(measured.headSha).toLowerCase() !== String(commitHash).toLowerCase()) {
    return { mode: 'full', reason: 'head_mismatch', measured };
  }
  if (measured.mergesClean === false) {
    return { mode: 'shots_only', reason: 'conflict', measured };
  }
  return { mode: 'full', reason: 'clean', measured };
}

module.exports = { decide, MANUAL_TRIGGERS };
