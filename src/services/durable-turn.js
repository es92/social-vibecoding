'use strict';

// A coding turn as a durable step: attach to it, or start it
// (docs/plans/bot-build-workflow.md, "Turns: attach or start").
//
// A turn is the one step of a build that goes on while nobody watches: it
// runs detached in its worker, and its journal is on the worker's volume.
// So it is kept in three moments:
//
//   1. before it is dispatched: { phase: 'started', deadlineAt, headBefore }
//   2. as its worker record is written (execInWorker `onTurnRecord`): its
//      record's identity, so a restart before the turn ends knows which
//      record on the session is this step's
//   3. once it has ended: { phase: 'done', out }; only then is the worker's
//      turn record released (worker.finishTurn), so there is no moment at
//      which a finished turn's result is in neither place.
//
// Run again (the next attempt of the work item, after a restart), the step:
//   - returns a saved result as it is, releasing the record again (which
//     does nothing if it already was);
//   - follows a record on the session that is this step's through its
//     journal to its end, settled in the ledger, its clock re-armed from the
//     saved deadline plus what the restarts cost it, a push the restart
//     caught done again from the worker;
//   - with no such record, reads the outside world before starting anything
//     again: a branch that moved past the commit the turn started from means
//     the turn landed and its record went, so its result is the branch tip
//     (the caller's `observe`); only a branch that did not move is
//     dispatched again, on what is left of its clock.
// What was saved is only ever a lower bound: no step puts the branch back
// where a checkpoint says it was.
//
// With the inert context (durable-steps.js none()), the turn is dispatched
// and timed exactly as before, and nothing is kept.

const log = require('./logger');
const durableSteps = require('./durable-steps');
const turnLifecycle = require('./turn-lifecycle');

// What a restart may cost a turn that runs on through it, given back on its
// clock once per restart that reached it (#4306): the worker never stops at a
// restart, and the turn loses only the calls it made back to the platform
// while the platform was down. Capped, so a turn a run of restarts keeps
// catching is not followed for ever.
const RESTART_ALLOWANCE_MS = 2 * 60 * 1000;
const MAX_RESTARTS_ALLOWED = 10;
// A turn dispatched again after its record was lost gets at least this.
const MIN_REDISPATCH_MS = 60 * 1000;
// What of a turn's result is kept: everything, its long texts clipped. A
// plan's (a `scout` turn's) answer is kept whole, up to the largest spec the
// platform reads (spec-html.js MAX_SPEC_HTML_CHARS, with its markdown): the
// step after it parses it, and a restart between the two must not hand that
// step a cut copy.
const KEPT_TEXT_CHARS = 20000;
const KEPT_SCOUT_CHARS = 800000;
const KEPT_PARTS = 40;

function allowanceMs(restarts) {
  const n = Number(restarts);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_RESTARTS_ALLOWED) * RESTART_ALLOWANCE_MS : 0;
}

/** A turn's routed result as a step keeps it: JSON, its long texts clipped. Pure. */
function keptRouted(routed, { mode = null } = {}) {
  if (!routed || typeof routed !== 'object') return routed ?? null;
  const max = (k) => (mode === 'scout' && (k === 'lastResultText' || k === 'answerParts') ? KEPT_SCOUT_CHARS : KEPT_TEXT_CHARS);
  const clip = (v, k) => (typeof v === 'string' && v.length > max(k) ? v.slice(0, max(k)) : v);
  const result = routed.result && typeof routed.result === 'object' ? { ...routed.result } : routed.result ?? null;
  if (result && typeof result === 'object') {
    for (const [k, v] of Object.entries(result)) result[k] = clip(v, k);
    if (Array.isArray(result.answerParts)) {
      // A plan's parts whole, and all of them; any other turn's last few.
      const parts = mode === 'scout' ? result.answerParts : result.answerParts.slice(-KEPT_PARTS);
      result.answerParts = parts.map((p) => clip(p, 'answerParts'));
    }
  }
  const error = routed.error instanceof Error ? routed.error.message : routed.error ?? null;
  return durableSteps.plain({ ...routed, result, error });
}

/**
 * Follow a turn whose record outlived the process that dispatched it to its
 * end, and settle it as the live path settles one: the journal replayed from
 * its start (worker.resumeTurnFromJournal), the record moved on to its tail,
 * the thread id the turn reported kept on the session, its ledger attempt
 * completed, and a build's commit that the restart kept from being pushed
 * pushed now. Resolves the routed result the attempt loop would have
 * (`{ result, estimatedCostUsd, logicalTurnId }`), or `{ notDispatched }`
 * for a record whose turn never started (its process went between writing
 * it and the dispatch).
 */
async function followTurn({ pool, session, activeTurn, onProgress = null, deps = {} }) {
  const worker = deps.worker || require('./worker');
  const agentTurn = deps.agentTurn || require('./agent-turn');
  const phase = turnLifecycle.phaseOf(activeTurn);
  const result = await worker.resumeTurnFromJournal(session.id, {
    journal: activeTurn.journal,
    turnId: activeTurn.turnId || null,
    agentBackend: activeTurn.backend || 'claude_code',
    agentHarness: activeTurn.harness || null,
    telemetryComponent: activeTurn.telemetryComponent || null,
    telemetryCorrelationId: activeTurn.telemetryCorrelationId || activeTurn.turnId || null,
    telemetryAttemptNumber: activeTurn.telemetryAttemptNumber || activeTurn.attemptNumber || 1,
    telemetryRequestMode: activeTurn.telemetryRequestMode || null,
    telemetryRequestTextCharacters: activeTurn.telemetryRequestTextCharacters ?? null,
    telemetryRequestSystemCharacters: activeTurn.telemetryRequestSystemCharacters ?? null,
    telemetryRequestPayloadCharacters: activeTurn.telemetryRequestPayloadCharacters ?? null,
    telemetryModelContextWindowTokens: activeTurn.telemetryModelContextWindowTokens ?? null,
    telemetryModelMaxOutputTokens: activeTurn.telemetryModelMaxOutputTokens ?? null,
    requestedModel: activeTurn.model || null,
    startedAt: activeTurn.startedAt || null,
    attemptNumber: activeTurn.attemptNumber || 1,
    billingByok: activeTurn.byok === true,
    providerWasDispatched: phase !== turnLifecycle.PHASE_DISPATCH_PENDING,
    byokCentsSoFar: Number(activeTurn.byokCents || 0),
    onProgress: typeof onProgress === 'function' ? onProgress : () => {},
    // The registry state execInWorker kept for this turn (worker.js).
    mode: activeTurn.mode || null,
    branchName: session.branch_name || null,
    stopRequestedAt: turnLifecycle.stopRequestOf(activeTurn)?.atMs || null,
  });
  if (phase === turnLifecycle.PHASE_EXECUTING || phase === turnLifecycle.PHASE_DISPATCH_PENDING) {
    await worker.markTurnTail(session.id, { sha: result.sha || null, pushOk: result.pushOk === true },
      turnLifecycle.cleanupArgs(activeTurn));
  }
  // A record its process wrote and never dispatched: no journal, no turn. So
  // is one whose agent left nothing at all before its process went (the
  // worker replaced, or the turn's process gone, before it ran): read as a
  // turn that returned nothing, it failed a plan or a build that never ran.
  const leftNothing = !String(result.rawStdout || '').trim() && !result.execExitSeen
    && GONE_BEFORE_IT_RAN.has(result.markerlessCause);
  if ((phase === turnLifecycle.PHASE_DISPATCH_PENDING && result.providerDispatched !== true && !result.execExitSeen) || leftNothing) {
    if (activeTurn.backend === 'codex_openrouter' && activeTurn.turnUuid) {
      await agentTurn.completeCodexAttempt({
        pool, turnUuid: activeTurn.turnUuid, status: 'failed', errorCode: 'not_dispatched',
      }).catch(() => {});
    }
    return { notDispatched: true };
  }
  await agentTurn.persistRecoveredAgentThread({ pool, session, result });
  const completion = await agentTurn.settleRecoveredAgentAttempt({ pool, activeTurn, result });
  let estimatedCostUsd = completion?.estimatedCost?.estimatedCostUsd;
  if (!Number.isFinite(estimatedCostUsd)) {
    estimatedCostUsd = await ledgerCostOfTurn(pool, activeTurn.logicalTurnId || activeTurn.turnId);
  }
  return {
    result,
    estimatedCostUsd: Number.isFinite(estimatedCostUsd) ? estimatedCostUsd : null,
    logicalTurnId: activeTurn.logicalTurnId || null,
    followed: true,
  };
}

// How a turn's process went with no exit marker (worker.js markerlessCause)
// that, with no output at all, means it never ran.
const GONE_BEFORE_IT_RAN = new Set(['container_gone', 'turn_process_gone']);

async function ledgerCostOfTurn(pool, logicalTurnId) {
  if (!logicalTurnId) return null;
  try {
    const { rows: [row] = [] } = await pool.query(
      'SELECT SUM(estimated_cost_usd)::float8 AS cost FROM agent_turns WHERE logical_turn_id = $1::uuid',
      [String(logicalTurnId)],
    );
    return row && row.cost != null && Number.isFinite(Number(row.cost)) ? Number(row.cost) : null;
  } catch {
    return null;
  }
}

/** Release a turn record a step holds. Nothing to release is not a failure. */
async function release(worker, sessionId, ids) {
  if (!ids || (!ids.turnId && !ids.journal)) return;
  try {
    await worker.finishTurn(sessionId, { turnId: ids.turnId || null, journal: ids.journal || null });
  } catch (err) {
    log.warn('durable-turn', 'Could not release a finished turn\'s record', { sessionId, err: err.message });
  }
}

/**
 * Run the turn `key` of a pipeline on the durable context `steps`.
 *
 *   dispatch({ holdTurnRecord, onTurnRecord }, { budgetMs })  starts the
 *     turn and resolves its routed result (sessions.runCodexAttemptLoop's),
 *     forwarding both options to worker.execInWorker; `budgetMs` is the
 *     clock it is started on (what is left of it, started again)
 *   stop()       ends the turn on its clock (homeroom-bot-live.js stopOnClock)
 *   budgetMs     its clock; on a later attempt, what is left of it
 *   mode         the record's mode ('build' | 'scout'), to know it as this step's
 *   head()       the branch tip now, or null when it cannot be read
 *   observe({ headBefore, tip })  a routed result for a turn that landed with
 *     its record gone (the branch moved), or null to start it again
 *   owner        the work item that runs the turn (turn-lifecycle.turnOwner),
 *     handed to the dispatch so the record names it
 *   fullBudgetAgain  a turn started again after its record was lost gets its
 *     whole clock, not what was left of it (a read, which a restart cannot
 *     observe on a branch and which a minute of clock cannot finish)
 *   prepare()    readies what a turn about to be started runs on (its
 *     worker), before its clock starts: the time it takes is not the turn's.
 *     Not called for a turn a restart caught, which is running already. A
 *     prepare that fails says so through what dispatch then does (the
 *     shots' records the error and its dispatch returns it); one that throws
 *     is the dispatch failing.
 *
 * Resolves { routed, stopped, stoppedBy, followed }: `stoppedBy` is a Stop
 * asked of the turn on its record (a person's, or its machine's), read as
 * the turn being stopped, never as it failing. Throws only a stop (the
 * context's).
 */
async function runTurn(steps, key, {
  pool, session, mode, budgetMs, dispatch, stop = null, head = null, observe = null, onProgress = null, deps = {},
  owner = null, fullBudgetAgain = false, prepare = null,
}) {
  const worker = deps.worker || require('./worker');
  const k = `turn:${key}`;
  const now = () => Date.now();
  let stopped = false;
  let timer = null;
  const arm = (ms) => {
    if (typeof stop !== 'function' || !Number.isFinite(ms)) return;
    timer = setTimeout(() => {
      stopped = true;
      Promise.resolve().then(() => stop()).catch(() => {});
    }, Math.max(0, ms));
    if (ms > 0 && typeof timer.unref === 'function') timer.unref();
  };
  const disarm = () => { if (timer) clearTimeout(timer); timer = null; };

  // The work item that runs the turn: given, or the one the durable context
  // was made for (build-runs.run sets it on a build's steps).
  const turnOwner = owner || steps?.turnOwner || null;
  const ownerExtra = turnOwner ? { owner: turnOwner } : {};
  if (!steps.active) {
    try {
      if (typeof prepare === 'function') await prepare();
      arm(budgetMs);
      return { routed: await dispatch({ ...ownerExtra }), stopped, followed: false };
    } catch (err) {
      // The dispatch failing is the turn failing, as a durable step reads it.
      if (err?.retainActiveTurn) throw err;
      return { routed: { error: `dispatch: ${err.message}` }, stopped, followed: false };
    } finally {
      disarm();
    }
  }

  let saved = steps.get(k) || null;
  if (saved?.phase === 'done') {
    await release(worker, session.id, saved.record);
    return { routed: saved.out?.routed ?? null, stopped: !!saved.out?.stopped, stoppedBy: saved.out?.stoppedBy || null, followed: false, kept: true };
  }

  // A Stop asked of this turn on its record, read before the record goes.
  const stopAsked = async (record) => {
    if (!record?.turnId) return null;
    const rec = await turnLifecycle.loadActiveTurn(pool, session.id).catch(() => null);
    if (!rec || String(turnLifecycle.turnIdentity(rec)) !== String(record.turnId)) return null;
    const asked = turnLifecycle.stopRequestOf(rec);
    return asked ? { by: asked.by || null, at: asked.at } : null;
  };
  const finish = async (out, record) => {
    steps.fence();
    const stoppedBy = await stopAsked(record || saved?.record);
    const kept = { routed: keptRouted(out.routed, { mode }), stopped: !!out.stopped, stoppedBy };
    await steps.set(k, { ...(saved || {}), phase: 'done', out: kept, record: record || saved?.record || null });
    await release(worker, session.id, record || saved?.record);
    return { ...out, stoppedBy };
  };

  let deadlineAt = null;
  if (saved?.phase === 'started') {
    const activeTurn = await turnLifecycle.loadActiveTurn(pool, session.id).catch(() => null);
    const ours = activeTurn && activeTurn.journal && (
      saved.record?.turnId ? String(turnLifecycle.turnIdentity(activeTurn)) === String(saved.record.turnId)
        : (!mode || activeTurn.mode === mode));
    if (ours) {
      const restarts = await turnLifecycle.noteRestart(pool, { sessionId: session.id, turnId: activeTurn.turnId }).catch(() => null);
      deadlineAt = Number(saved.deadlineAt) || now() + budgetMs;
      // The step's own clock had already stopped it before the restart.
      if (require('./homeroom-bot-live').botStopOf(activeTurn)) stopped = true;
      else arm(deadlineAt + allowanceMs(restarts) - now());
      log.info('durable-turn', 'Following a turn a restart caught', {
        sessionId: session.id, key, mode: activeTurn.mode, restarts,
      });
      const record = { turnId: turnLifecycle.turnIdentity(activeTurn), journal: activeTurn.journal || null };
      // The journal is replayed from the turn's start: a watcher counting
      // what the turn did counts it again from what it began with.
      await steps.tell({ kind: 'turn_follow', key: k, activeTurn });
      let followed;
      try {
        followed = await steps.race(followTurn({ pool, session, activeTurn, onProgress, deps }));
      } catch (err) {
        // The journal could not be followed (the worker went with the
        // restart): the turn failed, as a live turn whose journal broke off
        // does; its record goes with it.
        durableSteps.rethrowStop(err, `turn ${key}`);
        if (err?.retainActiveTurn) throw err;
        log.warn('durable-turn', 'A turn a restart caught could not be followed', { sessionId: session.id, key, err: err.message });
        disarm();
        return finish({ routed: { error: `the turn could not be followed after a restart (${err.message})` }, stopped }, record);
      } finally {
        disarm();
        await steps.tell({ kind: 'turn_followed', key: k });
      }
      if (!followed?.notDispatched) {
        return finish({ routed: followed, stopped, followed: true }, record);
      }
      // Never dispatched: its record goes, and the turn starts below.
      await release(worker, session.id, record);
      saved = { ...saved, record: null };
    } else if (typeof observe === 'function' && typeof head === 'function' && saved.headBefore) {
      // No record of this step's: the turn either landed and its record
      // went, or it never started. The branch says which.
      const tip = await head().catch(() => null);
      if (tip && tip !== saved.headBefore) {
        const routed = await observe({ headBefore: saved.headBefore, tip });
        if (routed) {
          log.info('durable-turn', 'A turn landed while its record was lost; taking the branch as it is', {
            sessionId: session.id, key, tip: String(tip).slice(0, 12),
          });
          return finish({ routed, stopped: false, followed: false, observed: true }, null);
        }
      }
    }
    deadlineAt = Number(saved.deadlineAt) || null;
  }

  // What it runs on, first: off its clock, which has not started.
  if (typeof prepare === 'function') {
    try {
      await steps.race(Promise.resolve().then(prepare));
    } catch (err) {
      durableSteps.rethrowStop(err, `turn ${key}`);
      if (err?.retainActiveTurn) throw err;
      return finish({ routed: { error: `dispatch: ${err.message}` }, stopped: false, followed: false }, null);
    }
  }
  // Start it (or start it again): on what is left of its clock, if it had one.
  const left = deadlineAt && !fullBudgetAgain ? Math.max(MIN_REDISPATCH_MS, deadlineAt - now()) : budgetMs;
  const headBefore = typeof head === 'function' ? await head().catch(() => null) : null;
  saved = { phase: 'started', mode: mode || null, deadlineAt: deadlineAt && !fullBudgetAgain ? deadlineAt : now() + left, headBefore, record: null };
  await steps.tell({ kind: 'turn_start', key: k });
  await steps.set(k, saved);
  let record = null;
  arm(left);
  let routed;
  try {
    routed = await steps.race(dispatch({
      ...ownerExtra,
      holdTurnRecord: true,
      onTurnRecord: async (r) => {
        record = { turnId: r.turnId || null, journal: r.journal || null };
        saved = { ...saved, record };
        await steps.set(k, saved);
      },
    }, { budgetMs: left }));
  } catch (err) {
    // A stop leaves the turn and its record to the next owner. Anything else
    // is the dispatch failing, which the caller reads as the turn failing,
    // as it always has; kept as the step's result, so a restart after it
    // reads the same failure instead of starting the turn again.
    durableSteps.rethrowStop(err, `turn ${key}`);
    if (err?.retainActiveTurn) throw err;
    routed = { error: `dispatch: ${err.message}` };
  } finally {
    disarm();
  }
  return finish({ routed, stopped, followed: false }, record);
}

/**
 * A turn's own clock ending it: only the turn its owner runs (by the
 * record's journal), and recorded as nobody's Stop (worker.stopOwnedTurn
 * with `stamp: false`). A turn with no owner (run on the inert context) is
 * stopped as it always was.
 */
function clockStop(worker, pool, sessionId, owner) {
  const own = owner && typeof owner === 'object' ? owner : null;
  return own
    ? worker.stopOwnedTurn(pool, { sessionId, machine: own.machine, key: own.key, kinds: [own.kind], workKey: own.workKey || null, stamp: false, release: false })
    : worker.stopTurn(sessionId);
}

module.exports = {
  runTurn, followTurn, keptRouted, allowanceMs, clockStop, RESTART_ALLOWANCE_MS, MAX_RESTARTS_ALLOWED,
};
